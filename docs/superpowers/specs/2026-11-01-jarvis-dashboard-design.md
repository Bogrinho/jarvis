# Jarvis: personal AI command center — design

Date: 2026-11-01
Owner: Stathis (Windows 11 Home, Node 24, Git installed)
Visual reference: `design/jarvis-mockup.html` (approved mockup — open it in a browser and click the account switcher)

## Intent and why

Stathis uses four AI subscriptions and today needs four separate apps to work with them:

| Account | What it's for | Subscription |
|---|---|---|
| Codex — Work ("Codex Δουλειά") | Company work only | ChatGPT Team (company) |
| Codex — Personal ("Codex Δικό μου") | Personal projects | ChatGPT Plus |
| Claude Code | Personal projects; works alongside Personal Codex (one plans/reviews, the other builds) | Claude Pro |
| Gemini | Not used yet — "we'll see" | Google AI Pro |

He wants **one window** — a dashboard styled like the "Jarvis" HUD from Chase AI's TikTok — where he picks an account with one button and runs several AI jobs **at the same time**, side by side, to be more productive. He also wants to see how much of each subscription's usage he has left.

Success: he opens Jarvis in the morning instead of the four official apps, starts two or three jobs in parallel on different projects/accounts, and glances at usage without opening anything else.

## Goals (v1)

1. **The HUD** — reproduce the approved mockup as the real app screen: Jarvis header + live clock, account switcher (4 accounts), system vitals (usage per account) on the left, weekly-usage card for the selected account, particle orb in the centre whose **shape and colour change per account** (Claude = constellation sphere/pink, Codex Work = spiral galaxy/blue-white, Codex Personal = ring/green, Gemini = four-point star/violet) with the morph animation, quick commands on the right, terminals dock at the bottom.
2. **Real terminals inside the window** — each job is a real interactive terminal session running the selected account's CLI (`codex`, `claude`, `gemini`) in a chosen project folder. Several can run at once. The dock shows one tab per running job, coloured by account; opening the dock shows terminals side by side (as in the mockup drawer). Jobs keep running when the dock is collapsed or another account is selected.
3. **Accounts kept apart** — each account is a separate login, all via subscription sign-in (no API keys):
   - Codex Work uses the existing `C:\Users\stath\.codex` (already signed in; logs show `plan_type: "team"`).
   - Codex Personal uses its own home, e.g. `C:\Users\stath\.codex-personal`, via the `CODEX_HOME` environment variable, signed in once with the Plus account.
   - Claude Code uses its normal home (`C:\Users\stath\.claude`).
   - Gemini uses Gemini CLI with Google sign-in; may be left unconfigured in v1 and shown as "not set up".
4. **Projects** — a short list of project folders, each marked Work or Personal. Starting a job = pick project + account (defaulting to the selected account).
5. **Usage** — show, per account, the best number available without API keys, with the time it was last updated:
   - Codex (both accounts): read the newest `rate_limits` entry from `<CODEX_HOME>\sessions\**\*.jsonl` — it contains `primary` (5-hour window) and `secondary` (weekly) `used_percent` and `resets_at`. Verified present in the work account's logs.
   - Claude: local logs under `C:\Users\stath\.claude\projects\**\*.jsonl` contain token counts per message but **no percentage**. Builder must find whether Claude Code exposes plan-limit percentages locally (e.g. in the status-line input or `/usage`). If yes, show %; if not, show tokens used in the last 5 hours / 7 days and label it as tokens, not %.
   - Gemini: show usage only if Gemini CLI exposes it locally; otherwise "no data".
6. **Quick commands** — buttons (Plan Today, Daily Brief, Code Review, New Project) defined in a config file; clicking one opens a new terminal job for the selected account with that prompt already sent. The list is editable in the config file.
7. **Directives** — the "top 3" list on the left is read from a Markdown file (e.g. `vault/today.md`, checkboxes). Editing the file updates the screen.

## Non-goals (v1)

- No voice (no Whisper/Kokoro, no "tap to talk").
- No automatic model router ("Jev") — Stathis picks the account himself.
- No control of the official desktop apps (Claude app, ChatGPT/Codex app, Gemini web) — only their CLIs.
- No API keys anywhere.
- No scheduled automations (7:00 briefing etc.), no "AI wire" news feed, no Obsidian plugin. The AI wire / Schedule panels can show placeholder text or be hidden. These are a later phase.
- No phone/remote access.

## Anti-goals (failure even if it "works")

- **Running a work project under a personal account, or a personal project under the work account.** Work projects must only start with Codex Work; Codex Work must not be offered for Personal projects. This must be hard to get wrong.
- Reading, displaying, copying or uploading the contents of any credentials file (`auth.json`, `.credentials.json`, OAuth tokens). Only the CLIs themselves touch credentials.
- Reachable from the network: the local server listens on `127.0.0.1` only.
- Burning CPU/battery when idle: pause the orb animation when the window is hidden/minimised.
- A different look from the mockup. The mockup is the spec for the visuals.

## Constraints

- Windows 11 Home, PowerShell + Git Bash available, Node 24 installed. Stathis is not a developer by trade; setup must be a few copy-paste steps plus one double-click to start.
- None of the CLIs are installed yet (he uses the desktop apps). Installing `codex`, `claude` and `gemini` CLIs is part of the work.
- The project folder is inside OneDrive (`C:\Users\stath\OneDrive\Έγγραφα\Jarvis`) and the path contains Greek characters. Native modules and paths must cope with both.
- All text a user sees can be English labels in the HUD style (as in the mockup) with Greek account names and project names as in the mockup.

## Decided "how"

- Local web app: a small Node server on `127.0.0.1` serving the HUD page; terminals rendered in the page with a terminal component connected to real pseudo-terminal processes on the server. (Builder picks libraries; xterm.js + node-pty is the obvious pair.)
- Visuals come straight from `design/jarvis-mockup.html` (fonts Jura + JetBrains Mono, colours, orb code with per-account shapes and frame-rate-independent morph).
- Configuration (accounts, projects, quick commands, file paths) lives in one human-editable file in the project folder.
- Started by double-clicking a shortcut/script that starts the server and opens the browser (or an app-style window).

## Decisions after builder review

Stathis decided:

- **Jobs survive closing the window.** The server runs in the background on its own. Closing the window (or reloading) leaves every job running; reopening Jarvis reattaches to them with their earlier output (keep a scrollback buffer per job). Only one server may run at a time; opening Jarvis again connects to the running one. There is a visible **"Shut down"** control that stops all jobs and the server. A PC restart or sign-out ends everything (no auto-start, no job restore after reboot).
- **Permissions per account.** Codex Work starts in its most cautious normal mode: it asks before every file change and every command. Claude Code and Codex Personal start in a mode that edits files inside the project folder freely and asks only before running commands that the CLI considers risky. Configurable per account in the config file. Builder finds each CLI's matching flags and must make this work natively on Windows (no WSL), reusing `C:\Users\stath\.codex` for Codex Work.

Claude's calls (Stathis can override):

- **Home folders for quick commands.** Each account has a home folder in config (Codex Work → a work folder; Claude / Codex Personal → a personal folder, by default `Jarvis\vault`). Quick commands run in the selected account's home folder. Prompts may tell the CLI to read `today.md` in that folder. A quick command can never run in a folder marked with the other side (work vs personal).
- **Project ↔ account rule.** Every project is Work or Personal. Work projects list only Codex Work; Personal projects list Claude, Codex Personal and Gemini. The server enforces this, not just the UI.
- **Mockup controls in v1:**
  - "Ask or continue…" box: starts a **new job** with that text for the selected account, in the most recently used project for that account (or its home folder if none).
  - Job states: kept simple — *Working* while the job printed output in the last few seconds, *Idle* otherwise, *Done* / *Error* from the process exit code. Shown on each terminal tab; the centre row reflects the job in focus. "Thinking" and "Auto" chips are removed.
  - Usage sparklines and the "per day" rate: the server stores a usage snapshot every refresh in a small local history file and draws them from that. Before there is enough history they show a flat line and no rate.
  - "Transcript" button and "Browse all skills": hidden in v1.
  - AI wire and Schedule panels: hidden in v1 (later phase).
- **Claude + Codex Personal working together:** side by side only — two separate jobs on the same project folder. No automatic hand-off between them in v1.

## Left to the builder

- Exact libraries, server framework, file layout, how the window is opened (browser tab vs app window).
- How to detect/install the three CLIs and guide the one-time sign-ins (including the separate `CODEX_HOME` login for Codex Personal).
- How often usage is refreshed.
- Layout of the terminal drawer when more than three jobs run.
- Whether to commit to git (a local repo is fine; no remote).
