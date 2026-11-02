# Jarvis Chat mode — design

Date: 2026-11-02 · Owner: Stathis · Builds on: `2026-11-01-jarvis-dashboard-design.md` (all its anti-goals still apply)
Visual spec (approved by Stathis): `public/mockup-chat.html` → moved to `design/chat-mockup.html`

## Intent

The terminal panes still feel like a terminal. Stathis wants to *talk* to the AIs inside Jarvis like in their own apps: chat bubbles, readable answers, compact cards for what the AI did, clear approval buttons — in the Jarvis HUD style ("futuristic, beautiful"). The terminal stays available as a fallback.

## Goals (v1)

1. **Chat conversations** for Codex Work, Codex Personal and Claude Code. Gemini stays terminal-only in v1.
2. **Look** = the approved mockup: glass panel in the account colour, header with orb + title + folder + state pill, user bubbles right, AI messages left with small orb avatar, activity cards ("Read 3 files", "Ran `npm test` ✓"), collapsible file-diff cards, amber approval card with **Επιτρέπεται / Όχι / Πάντα για αυτό**, typing indicator, composer with glowing send button, chips for model and permission mode. Enter sends, Shift+Enter new line. Greek UI text.
3. **Streaming**: assistant text appears as it is generated.
4. **Approvals in the UI**: whenever the CLI would ask (command, file change, other permission), Jarvis shows the approval card and sends the answer back. Nothing is approved automatically beyond what the account's permission mode already allows. "Πάντα για αυτό" = approve this kind of action for the rest of this conversation only.
5. **Survive closing the window**: conversations live in the server like terminal jobs; reopening shows the full transcript and any pending approval.
6. **Continue past conversations**: a "Συνέχεια συζήτησης" list per account and folder, showing past conversations (for Codex this includes ones made in the Codex desktop app when they share the same Codex home, e.g. "TestraTech"; for Claude, past Claude Code sessions in that folder). Opening one loads its history into the chat view and continues it.
7. **Starting**: "+ New terminal" becomes "+ Νέα συζήτηση" with a choice of **Chat** (default) or **Terminal**; quick commands and the Ask box start a **Chat** for chat-capable accounts.
8. **Markdown** in AI messages: paragraphs, bold/italic, lists, inline code, code blocks, links (shown, opened in a new tab) — rendered by building DOM nodes, never `innerHTML` with AI or file content.

## Non-goals (v1)

Switching a live conversation between chat and terminal; images/attachments; Gemini chat; editing/retrying past messages; voice; showing model "reasoning" text (a small "σκέφτεται…" indicator is enough).

## Anti-goals

- Any way for a work conversation to run under a personal account or folder, or vice versa (same rules as v1: server-side `resolveTarget`; resumed conversations are checked against the account + side too).
- Auto-approving something the user didn't approve; an approval reaching the wrong conversation.
- Rendering AI/file text as HTML (XSS).
- API keys; reading credential files; listening beyond 127.0.0.1; foreign web pages driving chats (same token + Host/Origin checks as v1).
- Losing a conversation's transcript because the window closed.

## Decided how

- **Codex** → one `codex app-server` child process per Codex account (stdio, JSON-RPC 2.0, one JSON object per line), started with that account's environment from `policy.buildEnv` (its own `CODEX_HOME`, API keys stripped). Methods: `initialize`, `thread/start` (cwd, approval policy + sandbox from the account mode: Work = on-request + read-only, Personal = on-request + workspace-write), `thread/resume`, `thread/list`, `thread/read` / `thread/items/list` for history, `turn/start`, `turn/interrupt`. Notifications: `item/started`, `item/completed`, `item/agentMessage/delta`, `turn/started`, `turn/completed`, `error`. Server requests (`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval`, legacy `execCommandApproval`, `applyPatchApproval`) become approval cards. Exact shapes: generate with `codex app-server generate-ts` (v0.166.0 installed) — the builder works from the generated types.
- **Claude Code** → one `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --permission-mode <acceptEdits|default> --permission-prompts host` process per conversation, in the conversation's folder; `--resume <session_id>` to continue. Permission questions arrive as control requests on stdout and are answered on stdin. Exact message shapes: the builder confirms from the installed Claude Code (v2.1.316) docs/strings and a real run.
- A **ChatManager** in the server owns conversations: normalized items (`user`, `assistant`, `activity`, `diff`, `approval`, `notice`, `error`), live state (`idle`/`working`/`waiting`/`error`), the transcript (capped), and an index in `data/chats.json` (conversation id, account, cwd, title, adapter thread/session id) so the server can offer to continue after a restart.
- Same REST + WebSocket server and security checks as v1; new endpoints/messages for chats.
- Front end: chat view component built from the mockup styles; terminal panes unchanged.

## Left to the builder

Library choices (none needed beyond Node built-ins is preferred), transcript cap size, exact activity-card wording, how many past conversations to list (≥ 20, newest first), polling vs events for history.
