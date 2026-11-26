// Both CLIs run this helper. Codex's trailing JSON and Claude's stdin can contain the conversation.
const { JARVIS_JOB_ID: id, JARVIS_URL: url, JARVIS_TOKEN: token } = process.env;
if (id && url && token) {
  try {
    await fetch(new URL(`/api/jobs/${encodeURIComponent(id)}/state`, url), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-jarvis-token': token },
      body: JSON.stringify({ id, state: process.argv[2] }),
      redirect: 'error',
      signal: AbortSignal.timeout(2000),
    });
  } catch { /* A closed or unreachable Jarvis must never interrupt the AI. */ }
}
process.exit(0);
