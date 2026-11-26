import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendSpeech, speechChanges } from '../public/voice.js';

test('append dictation to empty and existing drafts', () => {
  assert.equal(appendSpeech('', 'γεια'), 'γεια');
  assert.equal(appendSpeech('μια', 'λέξη'), 'μια λέξη');
  assert.equal(appendSpeech('μια ', 'λέξη'), 'μια λέξη');
});

test('deliver new finals once, strip terminal controls, and keep interim text separate', () => {
  const result = (transcript, isFinal) => ({ 0: { transcript }, isFinal });
  const results = [result('πριν', true), result('ένα\r\nδύο\x1b', true), result('τρία', false)];
  assert.deepEqual(speechChanges({ results, resultIndex: 1 }), { final: 'ένα δύο', interim: 'τρία' });
  assert.deepEqual(speechChanges({ results, resultIndex: 2 }), { final: '', interim: 'τρία' });
});
