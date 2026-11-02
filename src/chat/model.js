// Normalized chat model shared by ChatManager, adapters and the UI.
//
// Item kinds:
//   { id, kind:'user', text }
//   { id, kind:'assistant', text, streaming }
//   { id, kind:'activity', icon:'read'|'run'|'search'|'edit'|'tool', text, status:'running'|'ok'|'fail', detail? }
//   { id, kind:'diff', path, added, removed, patch }
//   { id, kind:'approval', approvalId, title, detail, command?, state:'pending'|'approved'|'denied'|'always'|'expired' }
//   { id, kind:'notice'|'error', text }

export class ChatError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.name = 'ChatError';
    this.code = code;
  }
}

export const DECISIONS = Object.freeze({ approve: 'approved', deny: 'denied', always: 'always' });
