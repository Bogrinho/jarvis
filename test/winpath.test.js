import test from 'node:test';
import assert from 'node:assert/strict';
import { mergePath, refreshWindowsPath } from '../src/winpath.js';

test('mergePath keeps the current order, adds new folders, drops duplicates and blanks', () => {
  assert.equal(mergePath('C:/a;C:/B;', 'c:/b;C:/new;;C:/a'), 'C:/a;C:/B;C:/new');
  assert.equal(mergePath(undefined, 'C:/x'), 'C:/x');
});

test('refreshWindowsPath merges the stored PATH and survives failure', { skip: process.platform !== 'win32' }, () => {
  const env = { Path: 'C:/a' };
  assert.equal(refreshWindowsPath({ env, exec: () => 'C:/a;C:/agy\r\n' }), true);
  assert.equal(env.Path, 'C:/a;C:/agy');
  const env2 = { Path: 'C:/a' };
  assert.equal(refreshWindowsPath({ env: env2, exec: () => { throw new Error('no powershell'); } }), false);
  assert.equal(env2.Path, 'C:/a');
});
