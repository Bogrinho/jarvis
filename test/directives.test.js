import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readDirectives } from '../src/directives.js';

test('reads first three checkbox lines with done flags', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-dir-'));
  const f = join(dir, 'd.md');
  await writeFile(f, '\uFEFF# Στόχοι\n- [ ] πρώτο  \n  * [x] second\n- [X] third\nnot a task\n- [ ] fourth\n', 'utf8');
  assert.deepEqual(await readDirectives(f), [
    { text: 'πρώτο', done: false },
    { text: 'second', done: true },
    { text: 'third', done: true },
  ]);
});

test('missing directives file gives empty list', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-dir-'));
  assert.deepEqual(await readDirectives(join(dir, 'nope.md')), []);
});
