# Jarvis Chat Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Talk to Codex (Work/Personal) and Claude Code inside Jarvis as a real chat with streaming, activity/diff cards, approval buttons and resumable history, in the approved HUD style.

**Architecture:** Two adapters translate each CLI's headless protocol (Codex `app-server` JSON-RPC over stdio; Claude Code `-p` stream-json over stdio) into one normalized event model. A `ChatManager` in the server owns conversations, transcripts, pending approvals and a small index file, and the existing server exposes them over REST + the existing WebSocket. The front end adds a chat view built from `design/chat-mockup.html`.

**Tech Stack:** Node 24 ESM, `node:child_process`, `node:test`; no new runtime dependencies. Existing: `ws`, `@lydell/node-pty`, `@xterm/xterm`.

**Spec:** `docs/superpowers/specs/2026-11-02-jarvis-chat-design.md` · visual spec `design/chat-mockup.html` · base spec `docs/superpowers/specs/2026-11-01-jarvis-dashboard-design.md`

## Global Constraints

- All v1 constraints stand: 127.0.0.1:4777 only; token + Host/Origin checks on every chat route and WS message; no API keys (child env from `buildEnv`, which strips inherited API keys); never read credential files; work/personal separation enforced server-side via `resolveTarget` for new AND resumed conversations.
- Codex Work: approval policy `on-request`, sandbox `read-only`. Codex Personal: `on-request`, `workspace-write`. Claude: `--permission-mode acceptEdits` for edit-in-project, `default` for cautious; `--permission-prompts host`.
- Nothing is approved without a user click, except what the mode itself allows. "Πάντα για αυτό" applies to the current conversation only.
- AI/file/command text is never inserted as HTML (`textContent`/DOM building only).
- Gemini: terminal only.
- Greek UI strings as in the mockup: `Επιτρέπεται`, `Όχι`, `Πάντα για αυτό`, `ΖΗΤΑΕΙ ΑΔΕΙΑ`, `σκέφτεται`, `Γράψε στο <Name>…`, `Νέα συζήτηση`, `Συνέχεια συζήτησης`, `Chat`, `Terminal`.
- Never start a real AI turn in automated tests; adapters are tested against fake CLI scripts. One manual real smoke test per adapter is allowed (a single short prompt like "Πες απλά: γεια").

## Review Focus

1. **An approval answer reaches the wrong conversation or a stale request** (two chats waiting at once; user clicks after the turn ended) → each approval has a unique id bound to one conversation; answering an unknown/finished id is a no-op error, never applied elsewhere. Test in Task 1 and Task 4.
2. **Resuming a past conversation from the other side** (a Personal account asked to resume a thread whose cwd is a Work project, or vice versa) → refused with `SIDE_MISMATCH`, nothing spawned. Test in Task 4.
3. **CLI process dies mid-turn / not logged in / malformed line** → conversation shows an error item and returns to a usable state; the server never crashes; other chats unaffected. Tests in Tasks 2 and 3.
4. **AI text containing HTML/script or markdown links like `javascript:`** → shown as text; links only `http(s):` and open with `rel="noopener noreferrer"`. Test in Task 5 (renderer unit test).
5. **Window closed while waiting for approval, then reopened** → transcript and the pending approval card come back and still work. Test in Task 4 (attach replays pending approval).

---

## File Structure

```
src/chat/model.js          normalized item/event types + helpers
src/chat/manager.js        ChatManager: conversations, transcripts, approvals, index file
src/chat/codex.js          CodexAppServer client (JSON-RPC over stdio) + adapter
src/chat/claude.js         Claude stream-json adapter
src/policy.js              (modify) export buildEnv
src/server.js              (modify) chat REST + WS messages
public/chat.js             chat view (DOM), markdown renderer
public/chat.css            chat styles (from design/chat-mockup.html)
public/app.js, index.html  (modify) "Νέα συζήτηση" picker Chat/Terminal, chats in dock/drawer
test/chat-*.test.js, test/fixtures/fake-codex-app-server.js, test/fixtures/fake-claude-stream.js
```

---

### Task 1: Normalized model and ChatManager

**Files:** Create `src/chat/model.js`, `src/chat/manager.js`; Test `test/chat-manager.test.js`

**Interfaces:**
- Produces:
  - Item kinds: `{ id, kind:'user', text }`, `{ id, kind:'assistant', text, streaming:boolean }`, `{ id, kind:'activity', icon:'read'|'run'|'search'|'edit'|'tool', text, status:'running'|'ok'|'fail', detail? }`, `{ id, kind:'diff', path, added:number, removed:number, patch:string }`, `{ id, kind:'approval', approvalId, title, detail, command?, state:'pending'|'approved'|'denied'|'always'|'expired' }`, `{ id, kind:'notice'|'error', text }`.
  - Adapter interface (implemented in Tasks 2–3): `adapter.start({ conv, resumeId? }) -> Promise<{ externalId }>`, `adapter.send(text)`, `adapter.interrupt()`, `adapter.answer(approvalToken, decision:'approve'|'deny'|'always')`, `adapter.close()`; adapter emits `'item'(item)`, `'delta'(itemId, textChunk)`, `'update'(itemId, patch)`, `'state'('working'|'idle'|'waiting'|'error')`, `'approval'({ token, title, detail, command? })`, `'exit'(code)`.
  - `class ChatManager extends EventEmitter` — `constructor({ adapters: { codex: (account, cwd)=>Adapter, claude: (account, cwd)=>Adapter }, indexFile, transcriptCap = 2000 })`; `create({ accountId, account, cwd, side, title, resumeId? }) -> Promise<ConvInfo>`; `list() -> ConvInfo[]`; `get(id) -> { info, items }`; `send(id, text)`; `interrupt(id)`; `answer(id, approvalId, decision)`; `close(id)`; `closeAll()`; events `'conv'(info)`, `'item'(id, item)`, `'delta'(id, itemId, text)`, `'update'(id, itemId, patch)`, `'removed'(id)`. `ConvInfo = { id, accountId, cwd, side, title, state, externalId, createdAt, updatedAt }`.
  - Index file `data/chats.json`: array of `{ id, accountId, cwd, side, title, externalId, updatedAt }` (no transcript text), written atomically, max 200 newest.
- [ ] **Step 1: failing tests** (fake adapter object): `create stores conversation and calls adapter.start`; `send appends a user item then forwards text`; `deltas build up the assistant item text`; `approval from adapter becomes a pending approval item with a new approvalId`; `answer with a known approvalId forwards decision once and marks item`; `answer for unknown or already-answered approvalId throws ChatError('NO_SUCH_APPROVAL') and forwards nothing`; `two conversations' approvals never cross`; `transcript capped at transcriptCap keeping newest`; `adapter exit while working adds an error item and state 'error'`; `index file lists conversations without message text`.
- [ ] **Step 2:** RED → **Step 3:** implement → **Step 4:** GREEN → **Step 5:** commit `feat(chat): conversation model and manager`.

### Task 2: Codex app-server adapter

**Files:** Create `src/chat/codex.js`; Modify `src/policy.js` (export `buildEnv`); Test `test/chat-codex.test.js`, `test/fixtures/fake-codex-app-server.js`

**Interfaces:**
- Consumes: adapter interface (Task 1), `buildEnv` (policy).
- Produces: `class CodexAppServer` — `constructor({ codexCmd = 'codex', env, spawn = child_process.spawn })`, `start()` (spawns `codex app-server` via `cmd.exe /d /c` on Windows, sends `initialize` with clientInfo `{ name:'jarvis', version }`), `request(method, params) -> Promise<result>`, `onNotification(fn)`, `onRequest(fn(method, params) -> Promise<result>)`, `close()`. One per Codex account, shared by that account's conversations; restarted lazily if it died.
  - `createCodexAdapter({ server, account, cwd })` implementing the adapter interface: `start` → `thread/start` { cwd, approvalPolicy:'on-request', sandbox: account.mode==='cautious' ? 'read-only':'workspace-write' } or `thread/resume` { threadId }; `send` → `turn/start` { threadId, input:[{ type:'text', text }] }; `interrupt` → `turn/interrupt`. Maps: agent message deltas → `delta`; completed `commandExecution` items → `activity` icon run with exit status; `fileChange` → `diff` per file; read/search tool items → `activity` read/search; approval server requests → `approval` (decision mapping approve→accept, deny→decline, always→acceptForSession); `turn/started`→`working`, `turn/completed`→`idle`.
  - `listCodexThreads({ server, cwd, limit=30 }) -> [{ externalId, title, updatedAt, cwd }]` via `thread/list` filtered to `cwd` (case-insensitive normalized), and `readCodexHistory({ server, threadId }) -> Item[]` via `thread/read`/`thread/items/list`.
- [ ] **Step 0:** run `codex app-server generate-ts --out <scratch>` and read `ClientRequest.ts`, `ServerRequest.ts`, `ServerNotification.ts` and the v2 param/response types for the methods above; note exact field names in the report. The fake server must speak the same shapes.
- [ ] **Step 1: failing tests** against the fake app-server script (spawned with `process.execPath`): `initialize then thread/start with cwd and sandbox per mode`; `turn streams deltas into one assistant item`; `commandExecution approval request becomes approval and decision maps to accept/decline/acceptForSession`; `resume uses thread/resume and history maps to items`; `listCodexThreads filters by cwd`; `server crash mid-turn emits error and exit, next send restarts server`; `malformed JSON line is ignored and logged`.
- [ ] **Step 2:** RED → **Step 3:** implement → **Step 4:** GREEN.
- [ ] **Step 5: real smoke (manual, once):** with `CODEX_HOME=C:\Users\stath\.codex-personal`, start a thread in `C:\Users\stath\Documents\Codex\2026-10-26\alakse-sto-biographiko-mou-sto-github`, send "Πες απλά: γεια", confirm a streamed reply and turn/completed; also `listCodexThreads` on `C:\Users\stath\.codex` for `C:\Users\stath\Documents\Codex\2026-05-17\act-as-my-coding-agent-we` lists the "TestraTech" thread (titles only in the report, no message content). Run from the user's real shell context is NOT needed: `codex` is at `C:\Users\stath\AppData\Roaming\npm\codex.cmd`.
- [ ] **Step 6:** commit `feat(chat): codex app-server adapter`.

### Task 3: Claude Code stream-json adapter

**Files:** Create `src/chat/claude.js`; Test `test/chat-claude.test.js`, `test/fixtures/fake-claude-stream.js`

**Interfaces:**
- Produces: `createClaudeAdapter({ account, cwd, env, claudeCmd = 'claude', spawn })` implementing the adapter interface. Spawns `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --permission-mode <acceptEdits|default> --permission-prompts host [--resume <sessionId>]` in `cwd` via `cmd.exe /d /c`. `send` writes one user message line; parses: init/system → `externalId = session_id`; partial text deltas → `delta`; assistant `tool_use` blocks → `activity` (Read/Glob/Grep → read/search, Bash → run with the command, Edit/Write → `diff` when old/new strings are available, else activity edit); `tool_result` → update status ok/fail; permission control requests → `approval`, answered with allow/deny (always → allow + remember tool name+input signature for this conversation and auto-allow identical requests); `result` → `idle`.
  - `listClaudeSessions({ claudeHome, cwd, limit=30 }) -> [{ externalId, title, updatedAt }]` from `<claudeHome>/projects/<cwd-slug>/*.jsonl` (first user message as title, truncated to 60 chars; never read files outside that folder), and `readClaudeHistory({ claudeHome, cwd, sessionId }) -> Item[]`.
- [ ] **Step 0:** confirm the exact stream-json input/output and permission control message shapes from the installed Claude Code (`claude --help`, docs/strings in the installed package, and one real run); record them in the report. Confirm how Claude Code names the project folder for a cwd (look at existing `~/.claude/projects` folder names vs their cwd).
- [ ] **Step 1: failing tests** against the fake stream script: `init yields externalId`; `partial deltas stream into one assistant item`; `Bash tool_use becomes run activity and result marks ok/fail`; `permission request → approval; approve/deny written back with the request id`; `always auto-allows an identical later request only in this conversation`; `resume passes --resume`; `process exit mid-turn → error + exit`; `listClaudeSessions reads only the cwd's project folder`.
- [ ] **Step 2:** RED → **Step 3:** implement → **Step 4:** GREEN.
- [ ] **Step 5: real smoke (manual, once):** in `C:\Users\stath\OneDrive\Έγγραφα\Jarvis`, send "Πες απλά: γεια" and confirm streamed reply + idle; do not approve any tool.
- [ ] **Step 6:** commit `feat(chat): claude stream-json adapter`.

### Task 4: Server wiring

**Files:** Modify `src/server.js`, `src/main.js`; Test `test/server-chat.test.js`

**Interfaces:**
- Consumes: ChatManager, adapters, `resolveTarget`, `allowedAccounts`.
- REST (all token + Host/Origin checked): `GET /api/chats` → ConvInfo[]; `POST /api/chats` `{ accountId, projectPath?, useHome?, prompt?, quickCommandId?, resumeId? }` → 201 ConvInfo (403 `{error}` on PolicyError; gemini → 400 `CHAT_UNSUPPORTED`); `GET /api/chats/:id` → `{ info, items }`; `POST /api/chats/:id/messages` `{ text }`; `POST /api/chats/:id/approvals/:approvalId` `{ decision }`; `POST /api/chats/:id/interrupt`; `DELETE /api/chats/:id`; `GET /api/chat-history?accountId=&projectPath=|useHome=1` → past conversations for that account+folder (resolved through `resolveTarget`).
- Resume: `resumeId` must come from the history list for the same account and resolved folder; the server re-checks the thread/session's cwd against the resolved target (SIDE_MISMATCH otherwise).
- WS: server → `{type:'chats', list}`, `{type:'chat-item', id, item}`, `{type:'chat-delta', id, itemId, text}`, `{type:'chat-update', id, itemId, patch}`; client → `{type:'chat-attach', id}` replies `{type:'chat-snapshot', id, info, items}` (includes pending approvals).
- Quick commands and the Ask box for chat-capable accounts create chats (Ask = `POST /api/chats` with `prompt`); terminal jobs unchanged.
- `main.js`: create ChatManager with real adapters; `Shut down` also closes chats.
- [ ] **Step 1: failing tests** (fake adapters): `chat routes reject foreign Origin and missing token`; `personal account cannot open work folder chat (SIDE_MISMATCH)`; `resume of a thread whose cwd is on the other side is refused`; `message flows to adapter and items reach attached ws`; `approval answer for another conversation's approvalId is 404`; `attach after reconnect replays transcript and pending approval`; `gemini chat → 400 CHAT_UNSUPPORTED`.
- [ ] **Step 2:** RED → **Step 3:** implement → **Step 4:** GREEN. **Step 5:** commit `feat(chat): server API`.

### Task 5: Chat front end

**Files:** Create `public/chat.js`, `public/chat.css`; Modify `public/app.js`, `public/index.html`; Test `test/markdown.test.js` (renderer is a pure function over a minimal DOM-builder interface so it runs in node:test)

**Interfaces:**
- Consumes: Task 4 API/WS.
- Produces: chat panes in the drawer next to terminal panes (same tabs, account colours); visuals from `design/chat-mockup.html` (header orb, bubbles, activity cards, collapsible diff, amber approval card with three buttons, typing indicator, composer, chips). Composer: Enter sends, Shift+Enter newline, disabled while sending; a Stop button while working (→ interrupt). "+ Νέα συζήτηση" picker: Chat (default) / Terminal, folder choice as today, plus "Συνέχεια συζήτησης" listing `/api/chat-history` results (title + time). Approval buttons disable after one click. Auto-scroll to newest unless the user scrolled up.
- `renderMarkdown(text, h)` where `h(tag, props, ...children)` builds nodes: supports paragraphs, `**bold**`, `*italic*`, `` `code` ``, fenced code blocks, `-`/`1.` lists, links `[t](url)` only for http/https (`target=_blank rel="noopener noreferrer"`), everything else as text.
- [ ] **Step 1: failing tests** for `renderMarkdown`: `script tags stay text`; `javascript: link becomes plain text`; `bold/code/list/code block structure`; `Greek text intact`.
- [ ] **Step 2:** RED → **Step 3:** implement renderer + views → **Step 4:** GREEN.
- [ ] **Step 5:** Verify in Chrome (Claude in Chrome) against a server started with fake adapters (a small dev script `scripts/dev-fake-chat.js` that boots the server with fake adapters emitting a scripted conversation including an approval): screenshot at 1440×900 and 390 px; compare with `design/chat-mockup.html`; click an approval button and confirm it resolves.
- [ ] **Step 6:** commit `feat(chat): HUD chat view`.
