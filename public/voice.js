const messages = {
  'not-allowed': 'Δεν δόθηκε άδεια για το μικρόφωνο',
  'service-not-allowed': 'Δεν δόθηκε άδεια για το μικρόφωνο',
  'no-speech': 'Δεν άκουσα τίποτα',
  network: 'Χρειάζεται internet για τη φωνή',
};

export function appendSpeech(value, text) {
  return value + (value && !/\s$/.test(value) ? ' ' : '') + text;
}

export function speechChanges({ results, resultIndex }) {
  const final = [];
  const interim = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    // Keep terminal input on one line and exclude control characters.
    const text = result[0].transcript.replace(/[\x00-\x1f\x7f-\x9f\s]+/g, ' ').trim();
    if (!text) continue;
    if (!result.isFinal) interim.push(text);
    else if (i >= resultIndex) final.push(text);
  }
  return { final: final.join(' '), interim: interim.join(' ') };
}

export function createDictation(getShortcutButton) {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) return { button: () => null, detach() {} };

  const pill = document.createElement('div');
  pill.className = 'voice-status';
  pill.setAttribute('role', 'status');
  pill.hidden = true;
  document.body.append(pill);
  let active;
  let pending;
  let silenceTimer;
  let errorTimer;

  function show(text) {
    pill.textContent = text;
    pill.hidden = !text;
  }

  function stop() {
    if (!active || active.stopping) return;
    active.stopping = true;
    clearTimeout(silenceTimer);
    active.rec.stop();
  }

  function resetSilence() {
    clearTimeout(silenceTimer);
    if (!active.stopping) silenceTimer = setTimeout(stop, 8000);
  }

  function start(button, onFinal) {
    clearTimeout(errorTimer);
    const rec = new Recognition();
    rec.lang = 'el-GR';
    rec.interimResults = true;
    rec.continuous = true;
    const session = { button, rec, stopping: false };
    active = session;
    let error = '';
    let delivered = false;
    button.setAttribute('aria-pressed', 'true');
    show('Ακούω…');
    rec.onstart = rec.onspeechstart = rec.onspeechend = resetSilence;
    rec.onresult = event => {
      if (active !== session || !button.isConnected) return;
      resetSilence();
      const { final, interim } = speechChanges(event);
      if (final) {
        onFinal(final, delivered);
        delivered = true;
      }
      show(interim ? 'Ακούω… ' + interim : 'Ακούω…');
    };
    rec.onerror = event => {
      if (event.error !== 'aborted') error = messages[event.error] || 'Σφάλμα αναγνώρισης φωνής';
    };
    const finish = () => {
      if (active !== session) return;
      clearTimeout(silenceTimer);
      active = null;
      button.setAttribute('aria-pressed', 'false');
      show(error);
      if (error) errorTimer = setTimeout(() => show(''), 4000);
      const next = pending;
      pending = null;
      if (next?.isConnected) next.click();
    };
    rec.onend = finish;
    try { rec.start(); }
    catch (err) {
      error = err.name === 'NotAllowedError' ? messages['not-allowed'] : 'Σφάλμα αναγνώρισης φωνής';
      finish();
    }
  }

  document.addEventListener('keydown', e => {
    if (e.code !== 'Space' || !e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.repeat) return;
    (active?.button || getShortcutButton())?.click();
  }, true);

  return {
    button(onFinal) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'voice-mic';
      button.textContent = '🎙';
      button.title = 'Φωνητική εντολή (Ctrl+Shift+Space)';
      button.setAttribute('aria-label', 'Φωνητική εντολή');
      button.setAttribute('aria-pressed', 'false');
      button.addEventListener('click', () => {
        if (!active) return start(button, onFinal);
        pending = active.button === button ? null : button;
        stop();
      });
      return button;
    },
    detach(button) {
      if (pending === button) pending = null;
      if (active && active.button === button) stop();
    },
  };
}
