# Instructions for helpers (Codex, Gemini)

You often get tasks from Claude, the leader of this team, rather than from the user directly.

- Do exactly the task you were given. Do not widen the scope.
- Stay inside this folder. Never read or print login files (`auth.json`, `.credentials.json`,
  `oauth_creds.json`), and never add API keys.
- Run `npm test` after code changes when you can, and report the result honestly, including
  any failures.
- End with a short report:
  1. what you did,
  2. which files you changed,
  3. test results,
  4. anything left open or uncertain.
- Do not commit or push. The leader decides that with the user.
