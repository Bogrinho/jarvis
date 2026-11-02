# Jarvis Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local Windows app, "Jarvis", that shows the approved HUD and runs Codex Work, Codex Personal, Claude Code and Gemini CLI jobs side by side in real terminals, with per-account usage.

**Architecture:** A Node server bound to `127.0.0.1:4777` owns pseudo-terminal jobs (they outlive the browser window), reads usage from each CLI's local files, and serves the HUD page. The page (ported from the mockup) talks to the server over REST + one WebSocket and renders terminals with xterm.js. A hidden launcher starts the server once and opens the browser.

**Tech Stack:** Node 24 (ESM, plain JS), `node:test`, `ws`, `@lydell/node-pty` (prebuilt Windows binaries), `@xterm/xterm` + `@xterm/addon-fit`. CLIs: `@openai/codex`, `@anthropic-ai/claude-code`, `@google/gemini-cli` (npm global).

**Spec:** `docs/superpowers/specs/2026-11-01-jarvis-dashboard-design.md` · visual spec `design/jarvis-mockup.html`

## Global Constraints

- Server listens on `127.0.0.1` only, port `4777`. Never `0.0.0.0`.
- No API keys anywhere. CLIs use subscription sign-in.
- Never read, show, copy or upload credentials files (`auth.json`, `.credentials.json`, OAuth tokens). Usage readers open only `sessions/**/*.jsonl` (Codex) and `projects/**/*.jsonl` (Claude).
- Codex Work = `CODEX_HOME=C:\Users\stath\.codex` (existing login, `plan_type: "team"`). Codex Personal = `CODEX_HOME=C:\Users\stath\.codex-personal`.
- Work projects may run only Codex Work; Personal projects may run only Claude, Codex Personal, Gemini. Enforced in the server.
- Permission modes: Codex Work = asks before every file change and command; Claude + Codex Personal = edit freely inside project, ask before risky commands. Configurable per account.
- Jobs survive closing/reloading the window; one server at a time; "Shut down" stops all jobs and the server. No restore after reboot.
- Visuals copied from `design/jarvis-mockup.html` (Jura + JetBrains Mono, account colours `#5b8cff` work, `#5fd39a` mine, `#e0609a` claude, `#a98bff` gemini, per-account orb shapes, frame-rate-independent morph). Hidden in v1: Transcript, Browse all skills, AI wire, Schedule, Thinking/Auto chips, voice.
- Pause the orb animation when `document.hidden`.
- Paths may contain Greek characters and spaces (project lives in `C:\Users\stath\OneDrive\Έγγραφα\Jarvis`).
- No voice, no router, no scheduled automations, no control of desktop apps.

## Review Focus

1. **A web page in another tab tries to drive the local server** (WebSocket or POST from a foreign `Origin`, or a DNS-rebinding `Host`) → rejected; only the Jarvis page with the per-start token can start jobs. Test in Task 7.
2. **A crafted request starts a Work project with a personal account (or a quick command in the other side's folder)** → 403, nothing spawned. Test in Task 2 and Task 7.
3. **Greek characters / spaces in paths** (`Έγγραφα`) for project folders, homes and config → job starts in the right folder, config loads. Test in Task 1 and Task 6.
4. **Fresh or broken usage data** (Codex Personal never used, missing `sessions`, half-written last JSONL line) → "no data", no crash, other accounts still shown. Test in Task 3 and Task 4.
5. **Huge output then reopen** (job printed many MB; window reopened; second double-click on the launcher) → scrollback capped at 512 KB and replayed; second launch opens the browser on the running server instead of starting another. Test in Task 6 and Task 7.

---

## File Structure

```
Jarvis/
  package.json              scripts: start, test
  jarvis.config.json        accounts, projects, quick commands, files (user-editable)
  .gitignore                node_modules/, data/
  src/
    config.js               load + validate config, resolve paths
    policy.js               side rules, launch command per account/mode
    jobs.js                 JobManager: pty jobs, scrollback, states
    directives.js           top-3 from Markdown checkboxes
    usage/codex.js          rate_limits from Codex session logs
    usage/claude.js         % from optional status file, else tokens from logs
    usage/history.js        snapshots → sparkline + per-day rate
    usage/index.js          collectUsage(config) for all accounts
    server.js               HTTP + WebSocket API, security checks
    main.js                 entry: single instance, start server, open browser
  public/
    index.html  styles.css  orb.js  app.js     HUD ported from mockup
  scripts/
    setup.ps1               install CLIs, create Codex Personal home, guide logins
    statusline.js           optional Claude status-line helper → data/claude-rate.json
  Jarvis.vbs                double-click launcher (hidden node + browser)
  vault/today.md            default directives file
  README.md                 Greek, step-by-step setup and use
  test/                     node:test files + fixtures/
  data/                     runtime: token, usage-history.json, server.log (git-ignored)
```

---

### Task 1: Project scaffold and config

**Files:**
- Create: `package.json`, `.gitignore`, `jarvis.config.json`, `vault/today.md`, `src/config.js`
- Test: `test/config.test.js`, `test/fixtures/config/*.json`

**Interfaces:**
- Produces: `loadConfig(filePath: string): Config` (throws `ConfigError` with a human-readable message naming the bad field). `Config = { rootDir, port, accounts: Record<AccountId, Account>, projects: Project[], quickCommands: QuickCommand[], directivesFile: string /*absolute*/ }`. `Account = { id, label, cli: 'codex'|'claude'|'gemini', side: 'work'|'personal', mode: 'cautious'|'edit-in-project', home: string|null /*absolute*/, env: Record<string,string>, enabled: boolean, color }`. `Project = { name, path /*absolute*/, side }`. `QuickCommand = { id, label, prompt }`.
- AccountIds in default config: `work`, `mine`, `claude`, `gemini` (gemini `enabled: false`).

- [ ] **Step 1:** `git init`; `npm init -y`; set `"type": "module"`, scripts `"test": "node --test test/"`, `"start": "node src/main.js"`; `.gitignore` = `node_modules/`, `data/`.
- [ ] **Step 2: Write failing tests** in `test/config.test.js`:
  - `loads default config` → `loadConfig('jarvis.config.json')` returns 4 accounts; `accounts.work.env.CODEX_HOME === 'C:\\Users\\stath\\.codex'`; `accounts.mine.env.CODEX_HOME === 'C:\\Users\\stath\\.codex-personal'`; `accounts.work.mode === 'cautious'`; `accounts.claude.mode === 'edit-in-project'`; `port === 4777`.
  - `resolves relative paths against rootDir, keeping Greek characters` → fixture with `"home": "vault"` and rootDir containing `Έγγραφα` gives `path.join(rootDir,'vault')`.
  - `rejects project with unknown side` → throws ConfigError matching `/projects\[0\]\.side/`.
  - `rejects account with unknown mode` → throws matching `/accounts\.work\.mode/`.
  - `rejects personal-side account sharing a home with a work-side account` → throws matching `/home/`.
- [ ] **Step 3:** Run `npm test` → FAIL (module missing).
- [ ] **Step 4:** Write `jarvis.config.json` (accounts as above, homes: work `null`, others `"vault"`; `projects: []`; quickCommands `plan-today` "Plan Today", `daily-brief` "Daily Brief", `code-review` "Code Review", `new-project` "New Project" with short English prompts that mention `today.md`; `directivesFile: "vault/today.md"`), `vault/today.md` with three `- [ ]` lines, and implement `loadConfig`.
- [ ] **Step 5:** `npm test` → PASS.
- [ ] **Step 6:** Commit `feat: scaffold and config loader`.

### Task 2: Install CLIs, side policy and launch commands

**Files:**
- Create: `src/policy.js`
- Test: `test/policy.test.js`

**Interfaces:**
- Consumes: `Config`, `Account`, `Project` (Task 1).
- Produces:
  - `allowedAccounts(config, side: 'work'|'personal'): AccountId[]` — enabled accounts whose `side` matches.
  - `resolveTarget(config, { accountId, projectPath?: string, useHome?: boolean }): { cwd: string, side }` — throws `PolicyError(code, message)`: `UNKNOWN_ACCOUNT`, `DISABLED`, `UNKNOWN_PROJECT` (projectPath not in config), `SIDE_MISMATCH` (project side ≠ account side), `NO_HOME`.
  - `buildLaunch(account): { file: string, args: string[], env: Record<string,string> }` — the prompt is NOT passed here (Task 6 types it in).

- [ ] **Step 1:** Install CLIs: `npm i -g @openai/codex @anthropic-ai/claude-code @google/gemini-cli`. Run `codex --help`, `claude --help`, `gemini --help` and confirm the flags in this table; if a flag name differs, use the real one and note it in the commit message:

  | cli | cautious | edit-in-project |
  |---|---|---|
  | codex | `--ask-for-approval untrusted --sandbox read-only` | `--ask-for-approval on-request --sandbox workspace-write` |
  | claude | `--permission-mode default` | `--permission-mode acceptEdits` |
  | gemini | `--approval-mode default` | `--approval-mode auto_edit` |

  Windows: npm installs `.cmd` shims, so `file` is `process.env.ComSpec || 'cmd.exe'` and `args` start with `['/d','/c', cli]`. Account `env` (e.g. `CODEX_HOME`) is merged over `process.env`.
- [ ] **Step 2: Write failing tests:**
  - `work project allows only codex work` → `allowedAccounts(cfg,'work')` deep-equals `['work']`; personal → `['mine','claude']` (gemini disabled).
  - `rejects personal account on work project` → `resolveTarget(cfg,{accountId:'claude', projectPath:workProj.path})` throws with `code === 'SIDE_MISMATCH'`.
  - `rejects work account on personal project` → same, `SIDE_MISMATCH`.
  - `rejects unknown project path` → `UNKNOWN_PROJECT` (path not listed, even if folder exists).
  - `useHome without a home` → work account (home null) throws `NO_HOME`.
  - `codex work launch is cautious with its own CODEX_HOME` → args include `'untrusted'` and `'read-only'`; `env.CODEX_HOME === 'C:\\Users\\stath\\.codex'`.
  - `codex personal launch uses personal home` → `env.CODEX_HOME` ends with `.codex-personal`; args include `'workspace-write'`.
  - `claude launch accepts edits` → args include `'acceptEdits'`.
- [ ] **Step 3:** `npm test` → FAIL. **Step 4:** implement `src/policy.js`. **Step 5:** `npm test` → PASS.
- [ ] **Step 6:** Commit `feat: side policy and per-account launch commands`.

### Task 3: Codex usage reader

**Files:**
- Create: `src/usage/codex.js`
- Test: `test/usage-codex.test.js`, `test/fixtures/codex-home/sessions/2026/11/01/rollout-a.jsonl`, `test/fixtures/codex-home-broken/…`

**Interfaces:**
- Produces: `readCodexUsage(codexHome: string): Promise<PercentUsage|null>`; `PercentUsage = { kind:'percent', fiveHour:{ pct:number, resetsAt:Date }, weekly:{ pct:number, resetsAt:Date }, plan:string|null, updatedAt:Date }`.
- Source: newest-by-mtime `.jsonl` files under `<codexHome>/sessions` (check at most 20 files); last line containing `"rate_limits"`; `primary` = 5-hour (`window_minutes: 300`), `secondary` = weekly (`10080`); `resets_at` is Unix seconds; `updatedAt` = that line's `timestamp`.

- [ ] **Step 1: Write failing tests:**
  - `reads 5h and weekly percent` → fixture line `{"timestamp":"2026-11-01T18:24:55.773Z", …"rate_limits":{"primary":{"used_percent":40.0,"window_minutes":300,"resets_at":1793343758},"secondary":{"used_percent":13.0,"window_minutes":10080,"resets_at":1793802196},"plan_type":"team"}}` → `fiveHour.pct===40`, `weekly.pct===13`, `plan==='team'`, `fiveHour.resetsAt.getTime()===1793343758000`.
  - `uses the newest rate_limits line` → two lines, returns the later one.
  - `missing sessions folder returns null` → `readCodexUsage(path-that-has-no-sessions)` resolves `null`.
  - `ignores a half-written last line` → last line truncated JSON; returns previous valid entry.
  - `never opens auth.json` → fixture home contains `auth.json` with content `SECRET`; spy on `fs.promises.open`/`readFile` (wrap via injected reader) and assert no path ends with `auth.json`.
- [ ] **Step 2:** FAIL → **Step 3:** implement (stream lines; no full-file JSON parse of huge files is fine to avoid, read last 2 MB of each file) → **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat: codex usage reader`.

### Task 4: Claude usage reader, Gemini placeholder, collectUsage

**Files:**
- Create: `src/usage/claude.js`, `src/usage/index.js`, `scripts/statusline.js`
- Test: `test/usage-claude.test.js`, `test/fixtures/claude-home/projects/x/session.jsonl`, `test/fixtures/claude-rate.json`

**Interfaces:**
- Consumes: `readCodexUsage` (Task 3), `Config` (Task 1).
- Produces:
  - `readClaudeUsage({ claudeHome, rateFile, now = new Date() }): Promise<PercentUsage|TokenUsage|null>`; `TokenUsage = { kind:'tokens', fiveHour:{ tokens:number }, weekly:{ tokens:number }, updatedAt:Date }`.
  - `collectUsage(config): Promise<Record<AccountId, PercentUsage|TokenUsage|{kind:'none', reason:string}>>` — codex accounts via `readCodexUsage(account.env.CODEX_HOME)`, claude via `readClaudeUsage({claudeHome:'C:\\Users\\stath\\.claude', rateFile:<root>/data/claude-rate.json})`, gemini → `{kind:'none', reason:'not set up'}` when disabled else `'no local usage data'`. One account failing never rejects the whole call.
- `rateFile` is written by `scripts/statusline.js` (optional; wired up only with the user's OK during setup, Task 9): it reads Claude Code's status-line JSON from stdin, and if it has a rate-limit section (`rate_limits.five_hour.used_percentage`, `rate_limits.seven_day.used_percentage`, `resets_at` — confirm the exact field names against the installed Claude Code's status-line docs), writes `{fiveHour:{pct,resetsAt}, weekly:{pct,resetsAt}, updatedAt}` to the rate file, then prints a short status line.

- [ ] **Step 1: Write failing tests:**
  - `prefers percent from a fresh rate file` → rate file updatedAt 10 min before `now` → `kind==='percent'`, `weekly.pct===39`.
  - `ignores a rate file older than 6 hours and falls back to tokens` → `kind==='tokens'`.
  - `sums tokens in last 5h and 7 days` → fixture with messages at now-1h (`input 100, output 50, cache_creation 200`), now-2d (`output 1000`), now-9d (`output 9999`) → `fiveHour.tokens===350`, `weekly.tokens===1350` (cache_read tokens excluded).
  - `no projects folder returns null`.
  - `collectUsage keeps going when one account throws` → stub codex reader throws for `mine`; result has `mine.kind==='none'` and `work.kind==='percent'`.
- [ ] **Step 2:** FAIL → **Step 3:** implement → **Step 4:** PASS. **Step 5:** Commit `feat: claude usage and collectUsage`.

### Task 5: Usage history and directives

**Files:**
- Create: `src/usage/history.js`, `src/directives.js`
- Test: `test/history.test.js`, `test/directives.test.js`

**Interfaces:**
- Produces:
  - `appendSnapshot(file, accountId, pct: number, at: Date): Promise<void>` — keeps 14 days, at most one point per account per 15 min.
  - `getSeries(file, accountId, days = 7, now = new Date()): Promise<{ at: Date, pct: number }[]>`.
  - `perDayRate(series): number|null` — `null` with fewer than 2 points or span < 6 h; otherwise pct change per 24 h between first and last point, ignoring drops (a weekly reset) by restarting from the point after the drop.
  - `readDirectives(file): Promise<{ text: string, done: boolean }[]>` — first 3 `- [ ]` / `- [x]` lines; missing file → `[]`.

- [ ] **Step 1: Write failing tests:** `throttles to one point per 15 minutes`; `drops points older than 14 days`; `perDayRate is null with one point`; `perDayRate 10→22 over 2 days is 6`; `perDayRate restarts after a reset` (30, 40, 2, 8 over 24 h steps → 6); `reads first three checkbox lines with done flags`; `missing directives file gives empty list`.
- [ ] **Step 2:** FAIL → **Step 3:** implement → **Step 4:** PASS. **Step 5:** Commit `feat: usage history and directives`.

### Task 6: JobManager (pseudo-terminal jobs)

**Files:**
- Create: `src/jobs.js`
- Test: `test/jobs.test.js`, `test/fixtures/fake-cli.js` (echoes stdin lines as `ECHO:<line>`, prints `READY` on start, exits 3 on input `quit`)

**Interfaces:**
- Consumes: `buildLaunch` output shape (Task 2).
- Produces: `class JobManager extends EventEmitter`
  - `constructor({ spawn = pty.spawn, scrollbackBytes = 512*1024, idleMs = 3000, promptDelayMs = 1500 })`
  - `start({ accountId, cwd, launch: {file,args,env}, title, prompt? }): JobInfo` — spawns with `cols 120, rows 30`, `useConpty: true`, `cwd`. If `prompt`, writes `prompt + '\r'` once the job has produced output and then been quiet for `promptDelayMs` (typing it avoids shell-quoting of Greek/quotes).
  - `list(): JobInfo[]`; `attach(id): { info: JobInfo, scrollback: string }`; `write(id, data)`; `resize(id, cols, rows)`; `kill(id)`; `killAll(): Promise<void>`.
  - Events: `'data' (id, chunk)`, `'state' (id, state)`, `'exit' (id, exitCode)`.
  - `JobInfo = { id: string, accountId, cwd, title, state: 'working'|'idle'|'done'|'error', startedAt: number, exitCode: number|null }`. State: `working` on output, `idle` after `idleMs` without output, `done` on exit 0, `error` on non-zero exit.

- [ ] **Step 1:** `npm i @lydell/node-pty`. Verify it loads: `node -e "import('@lydell/node-pty').then(m=>console.log(typeof m.spawn))"` → `function`.
- [ ] **Step 2: Write failing tests** (real pty, launching `process.execPath fake-cli.js`):
  - `runs in a cwd with Greek characters and spaces` → temp dir `Έγγραφα test`; fake CLI prints `process.cwd()`; scrollback contains `Έγγραφα test`.
  - `types the initial prompt after the CLI is ready` → prompt `Γεια "σου"` → scrollback contains `ECHO:Γεια "σου"`.
  - `state goes working → idle → error on exit 3` (idleMs 200).
  - `scrollback is capped` → fake CLI prints 2 MB; `attach(id).scrollback.length <= 512*1024` and ends with the last printed marker.
  - `killAll ends every job`.
- [ ] **Step 3:** FAIL → **Step 4:** implement → **Step 5:** PASS. **Step 6:** Commit `feat: pty job manager`.

### Task 7: Server API and security

**Files:**
- Create: `src/server.js`, `src/main.js`
- Test: `test/server.test.js`

**Interfaces:**
- Consumes: `loadConfig`, `resolveTarget`, `allowedAccounts`, `buildLaunch`, `JobManager`, `collectUsage`, `appendSnapshot`, `getSeries`, `perDayRate`, `readDirectives`.
- Produces: `createServer({ config, jobs, token, usageIntervalMs = 60000 }): { listen(): Promise<void>, close(): Promise<void> }`.
  - Token: random 32-byte hex created by `main.js` per start, embedded into `index.html` as `<meta name="jarvis-token">` when served.
  - Every `/api/*` request and the WebSocket upgrade must have `Host` = `127.0.0.1:4777` or `localhost:4777`, and (if present) `Origin` = `http://127.0.0.1:4777` or `http://localhost:4777`, plus header/query `token`. Otherwise 403.
  - `GET /api/state` → `{ accounts: [{id,label,side,color,enabled}], projects, quickCommands, jobs: JobInfo[], usage: Record<id, view & { series:number[], perDay:number|null }>, directives }`.
  - `POST /api/jobs` body `{ accountId, projectPath?, useHome?, prompt?, quickCommandId? }` → `resolveTarget` (403 + `{error: code}` on PolicyError) → `jobs.start` → `201 JobInfo`.
  - `POST /api/shutdown` → `jobs.killAll()`, respond 200, then exit process (via injected `onShutdown`).
  - WS `/ws?token=…`: client → `{type:'attach',id}` (reply `{type:'scrollback',id,data}`), `{type:'input',id,data}`, `{type:'resize',id,cols,rows}`, `{type:'kill',id}`; server → `{type:'data',id,data}`, `{type:'jobs',list}`, `{type:'usage',usage}`.
  - Static: `public/` and `/vendor/xterm/*` from `node_modules/@xterm`.
  - `main.js`: load config; try to listen; on `EADDRINUSE` check `GET /api/ping` responds `jarvis` → just open the browser and exit 0; else log error to `data/server.log`. After listening, open `http://127.0.0.1:4777/` (`cmd /c start "" <url>`) unless `--no-open`. Logs to `data/server.log`.

- [ ] **Step 1:** `npm i ws @xterm/xterm @xterm/addon-fit`.
- [ ] **Step 2: Write failing tests** (server on an ephemeral port with injected port in host checks; JobManager with fake spawn):
  - `rejects foreign Origin` → POST `/api/jobs` with `Origin: https://evil.example` → 403, no spawn.
  - `rejects rebinding Host` → `Host: evil.example:4777` → 403.
  - `rejects missing token` → 403; WS upgrade without token → socket closed/401.
  - `refuses work project with claude` → 403 `{error:'SIDE_MISMATCH'}`, spawn not called.
  - `starts a job and streams data over ws` → attach gets scrollback; data event forwarded.
  - `quick command runs in account home` → `{accountId:'claude', quickCommandId:'plan-today'}` spawns with cwd = claude home and prompt = that command's prompt; same for `work` (home null) → 403 `NO_HOME`.
  - `ping answers jarvis`; `shutdown kills jobs and calls onShutdown`.
  - `binds to 127.0.0.1 only` → `server.address().address === '127.0.0.1'`.
- [ ] **Step 3:** FAIL → **Step 4:** implement → **Step 5:** PASS. **Step 6:** Manual: `npm start -- --no-open`, run `npm start` again in a second terminal → second one prints "already running" and exits 0.
- [ ] **Step 7:** Commit `feat: local server with job API and security checks`.

### Task 8: HUD front end

**Files:**
- Create: `public/index.html`, `public/styles.css`, `public/orb.js`, `public/app.js` (split from `design/jarvis-mockup.html`)

**Interfaces:**
- Consumes: Task 7 API and WS messages.
- Behaviour (all from the spec + mockup):
  - Switcher: 4 buttons from `/api/state.accounts`; disabled accounts greyed with "not set up". Selecting sets `--acc-rgb`, orb shape (`setShape(id)`), centre name (`CODEX`/`CLAUDE`/`GEMINI`), subtitle, weekly card. Selection remembered in `localStorage` (try/catch).
  - Vitals: one row per account; percent kind → big `NN%` (weekly) + small `5h NN%` + reset time; tokens kind → `NNk tokens / 7d` labelled "tokens"; none → "no data" / "not set up". Sparkline from `series`, `▲ N% /μέρα` only when `perDay` not null. Updated from WS `usage`.
  - Directives from state; Quick commands → `POST /api/jobs {accountId:selected, quickCommandId}`; show the server error text in a small inline message (e.g. `NO_HOME` → "Ορίσε φάκελο για αυτόν τον λογαριασμό στο jarvis.config.json").
  - "Ask or continue…": Enter → `POST /api/jobs {accountId, projectPath:lastProject[accountId] ?? undefined, useHome: !lastProject, prompt}`.
  - "+ New terminal": small picker listing only projects of the selected account's side (from `allowedAccounts` rule mirrored client-side) plus "home folder".
  - Dock: one tab per job (account colour dot, title, state); clicking opens the drawer with xterm panes (up to 3 side by side, more wrap to a second row); each pane attaches via WS, forwards input/resize, has a ✕ that sends `kill` after confirm.
  - State chips: Idle / Working / Done / Error reflect the focused job.
  - Header: "Shut down" button (confirm dialog: "Σταματάνε όλες οι δουλειές. Συνέχεια;") → `POST /api/shutdown`.
  - Hidden: Transcript, Browse all skills, AI wire, Schedule, Thinking/Auto chips.
  - Orb pauses when `document.hidden`; respects reduced motion as in mockup.
- [ ] **Step 1:** Port markup/CSS/orb from the mockup unchanged in look; replace demo data with state from the API.
- [ ] **Step 2:** Start server, open `http://127.0.0.1:4777`. Verify by hand, checking each: switcher morphs orb; usage for `work` shows the real % (compare with numbers in the newest `C:\Users\stath\.codex\sessions` file); new terminal on a Personal project lists only Claude/Codex Personal; a job keeps running after closing the tab and reopening shows its output; Shut down stops the server.
- [ ] **Step 3:** Screenshot at 1440×900 and at 390 px wide; layout matches mockup and no horizontal scroll.
- [ ] **Step 4:** Commit `feat: Jarvis HUD front end`.

### Task 9: Launcher, setup script, README

**Files:**
- Create: `Jarvis.vbs`, `scripts/setup.ps1`, `README.md`

**Interfaces:**
- Consumes: `npm start` (Task 7), `scripts/statusline.js` (Task 4).
- `Jarvis.vbs`: runs `node src\main.js` from its own folder with a hidden window (`WScript.Shell.Run …, 0, False`); works when the folder path contains Greek characters.
- `scripts/setup.ps1` (idempotent, prints each step in Greek): checks Node ≥ 20; `npm install` in the project; installs the three CLIs if missing; creates `C:\Users\stath\.codex-personal`; prints the exact commands for the one-time logins and does NOT run them itself:
  - Codex Personal: `$env:CODEX_HOME="$HOME\.codex-personal"; codex login` (sign in with the Plus account)
  - Codex Work: already signed in (only if `codex login status` with default home fails, print `codex login`)
  - Claude: `claude` then `/login`
  - Gemini (optional): `gemini` and choose Google sign-in
  Creates a desktop shortcut to `Jarvis.vbs` named "Jarvis".
  Offers (Y/N prompt) to add the Claude status-line helper (`scripts/statusline.js`) to `~/.claude/settings.json`; skip if a `statusLine` is already set.
- `README.md` (Greek): what Jarvis is; setup in 4 steps; how to add projects to `jarvis.config.json` (example for a Work and a Personal project); how usage is measured per account; how to shut down; troubleshooting (OneDrive syncing `node_modules`, port 4777 busy, "no data" for Codex Personal until first use).
- [ ] **Step 1:** Write the three files.
- [ ] **Step 2:** Run `powershell -ExecutionPolicy Bypass -File scripts\setup.ps1` → finishes without errors, shortcut exists on the Desktop.
- [ ] **Step 3:** Double-click the shortcut → browser opens Jarvis; double-click again → same server, second tab, no second process (`Get-Process node` count unchanged).
- [ ] **Step 4:** `npm test` → all PASS. Commit `feat: launcher, setup script and README`.
