#!/usr/bin/env node
// Claude Code status-line command. Reads the status-line JSON from stdin; if it carries
// rate_limits.five_hour / seven_day (used_percentage, resets_at = Unix seconds), writes
// them to the Jarvis rate file, then prints a short status line. Never throws.
// Rate file: argv[2], else $JARVIS_RATE_FILE, else <jarvis root>/data/claude-rate.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rateFile = process.argv[2] || process.env.JARVIS_RATE_FILE || path.join(root, 'data', 'claude-rate.json');

function win(w) {
  if (!w || typeof w.used_percentage !== 'number' || typeof w.resets_at !== 'number') return null;
  if (!Number.isFinite(w.used_percentage) || !Number.isFinite(w.resets_at)) return null;
  return { pct: w.used_percentage, resetsAt: new Date(w.resets_at * 1000).toISOString() };
}

let raw = '';
try {
  raw = fs.readFileSync(0, 'utf8');
} catch {
  /* no stdin */
}

let input = null;
try {
  input = JSON.parse(raw);
} catch {
  /* ignore malformed input */
}

const five = win(input?.rate_limits?.five_hour);
const week = win(input?.rate_limits?.seven_day);
if (five && week) {
  try {
    fs.mkdirSync(path.dirname(rateFile), { recursive: true });
    const tmp = `${rateFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ fiveHour: five, weekly: week, updatedAt: new Date().toISOString() }));
    fs.renameSync(tmp, rateFile);
  } catch {
    /* status line must never fail */
  }
}

const model = typeof input?.model?.display_name === 'string' ? input.model.display_name : 'Claude';
const parts = [model];
if (five) parts.push(`5h ${Math.round(five.pct)}%`);
if (week) parts.push(`7d ${Math.round(week.pct)}%`);
process.stdout.write(parts.join(' | ') + '\n');
