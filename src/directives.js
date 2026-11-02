import { readFile } from 'node:fs/promises';

const LINE = /^\s*[-*]\s+\[([ xX])\]\s+(.*\S)\s*$/;

export async function readDirectives(file) {
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return [];
  }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = LINE.exec(line);
    if (!m) continue;
    out.push({ text: m[2].trim(), done: m[1] !== ' ' });
    if (out.length === 3) break;
  }
  return out;
}
