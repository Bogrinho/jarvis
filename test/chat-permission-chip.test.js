import { test } from 'node:test';
import assert from 'node:assert/strict';
import { permissionText } from '../public/chat.js';

test('permission chip text matches what each cli+mode really does', () => {
  assert.equal(permissionText('codex', 'cautious'), 'μόνο ανάγνωση · ρωτάει για τα υπόλοιπα');
  assert.equal(permissionText('codex', 'edit-in-project'), 'αλλάζει αρχεία στο project · ρωτάει εκτός');
  assert.equal(permissionText('claude', 'edit-in-project'), 'δέχεται αλλαγές αρχείων · ρωτάει για εντολές');
  assert.equal(permissionText('claude', 'cautious'), 'ρωτάει πριν από αλλαγές και εντολές');
});
