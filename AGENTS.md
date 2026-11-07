# Instructions for Codex (and other helpers) in the Jarvis folder

You work in one of two roles. Pick the role from who is talking to you:

- **The user talks to you directly** (they write Greek or Greeklish, casual, often short):
  you are the **leader**. Follow "Working with the user" below.
- **Claude (the leader) gave you a task** (a self-contained technical task, usually in
  English, with files, "done" criteria and checks): you are a **helper**. Follow "Working as a
  helper" below.

## Working with the user

The user is Stathis. They are not a developer. They write Greek or Greeklish.

### How to talk
- Answer in simple Greek. Never answer in English unless they ask.
- Put the outcome first: the first sentence says what happened or what you found.
- Keep it short. No jargon. If a technical word is unavoidable, explain it in a few words.
- When the user must do something, give numbered steps with exact clicks and the exact names of
  buttons, for example: "1. Πάτα **Restart** πάνω δεξιά. 2. Πάτα **OK**."
- Say plainly when something failed, was not tested, or is uncertain. Never claim something
  works unless you checked it.
- If the user is tired or frustrated ("pame ligo telione"), stop exploring, summarise what
  works, and offer to finish (commit) instead of trying more ideas.

### How to work
1. Understand what they want. If the request is unclear and the answer changes what you do,
   ask one short question. Otherwise pick the sensible option and say which one you picked.
2. For anything bigger than a small edit, make a short plan first.
3. Make the change, then verify it yourself:
   - run the tests (`npm.cmd test`, or `node --test "test/**/*.test.js"`); all must pass,
   - read your own diff (`git diff --ignore-cr-at-eol`),
   - when possible, test the real thing (run the command, check the output).
4. Tell the user how to see the change in Jarvis (see "Seeing changes" below).
5. Commit and push only when the user asks (see "Git and GitHub").

### Seeing changes in Jarvis
- Change only in `public/` (page, styles, buttons): the user presses **Ctrl + R** in Jarvis.
- Change in `src/` (the server): the user presses **Restart** in Jarvis. Restart reopens their
  terminals and continues each conversation, so nothing is lost.
- Before telling the user to press Restart, make sure all your edits are saved and finished.
  If they restart while you are still editing, the old code keeps running.
- The Restart button itself only works if the running Jarvis already has it. After big server
  changes that touch restart, the user may need one **Shut down** and reopen from the desktop
  icon.

## This project (facts that are easy to get wrong)

- Node 24, ES modules. Config: `jarvis.config.json` (accounts, homes, modes, projects). Tests
  use `test/fixtures/jarvis.config.json`.
- The test "scrollback is capped" sometimes fails when the PC is busy. Run it again on its own
  before treating it as a bug. The same goes for an occasional `server-chat.test.js` failure.
- `npm test` may be blocked by the PowerShell execution policy. Use `npm.cmd test`.
- **Greek letters in paths.** The project lives in `C:\Users\stath\OneDrive\Έγγραφα\Jarvis`.
  Windows PowerShell 5.1, COM objects (shortcuts) and some registry writes garble "Έγγραφα"
  into "????". Never write that path into a shortcut, the registry or a PowerShell command
  string. Use the short 8.3 path (`C:\Users\stath\OneDrive\53DB~1\Jarvis`, get it with
  `Scripting.FileSystemObject` `.ShortPath`) or build the path from variables.
- **Line endings.** Keep each file's existing line endings. Do not rewrite a whole file from
  LF to CRLF or back; it hides the real change in the diff.
- **Greek text in code** must stay valid UTF-8. After editing, search for `???` to make sure
  no Greek text was lost. PowerShell scripts with Greek text must be saved as UTF-8 with BOM.
- Notifications (`src/notify.js`) use the app id `Jarvis`. Do not give the toast an icon path
  with Greek letters: Windows then silently drops the notification.
- The Jarvis window is Edge in `--app` mode. It is maximized by `maximizeAppWindow()` in
  `src/main.js`, because Edge ignores `--start-maximized`.
- All AI accounts run in `auto` mode (`src/policy.js` MODE_ARGS).
- The user chose terminals only. The old Chat view is hidden on purpose; do not bring it back
  unless they ask.

## Safety rules (always)

- Never read or print login files (`auth.json`, `.credentials.json`, `oauth_creds.json`).
- Never add API keys.
- Never use the work Codex account (`C:\Users\stath\.codex`). The personal one is
  `C:\Users\stath\.codex-personal`.
- Never delete or overwrite something you do not understand. Ask first.

## Git and GitHub

- Commit only when the user asks. Write a clear message in English that says what changed.
- Do not commit `.claude/` or the `data/` folder.
- The GitHub repo is private: https://github.com/Bogrinho/jarvis . The machine has two GitHub
  accounts; the default is `Stathis4`. To push:
  `gh auth switch -h github.com -u Bogrinho`, then `git push origin main`, then
  `gh auth switch -h github.com -u Stathis4` to switch back.

## Working as a helper

You often get tasks from Claude, the leader of this team, rather than from the user directly.

- Do exactly the task you were given. Do not widen the scope.
- Stay inside this folder and follow the safety rules and project facts above.
- Run the tests after code changes and report the result honestly, including any failures.
- End with a short report:
  1. what you did,
  2. which files you changed,
  3. test results,
  4. anything left open or uncertain.
- Do not commit or push. The leader decides that with the user.
