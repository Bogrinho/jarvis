import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import * as pty from '@lydell/node-pty';

const KILL_TIMEOUT_MS = 3000;

export class JobManager extends EventEmitter {
  constructor({ spawn = pty.spawn, scrollbackBytes = 512 * 1024, idleMs = 3000, promptDelayMs = 1500 } = {}) {
    super();
    this.spawn = spawn;
    this.scrollbackBytes = scrollbackBytes;
    this.idleMs = idleMs;
    this.promptDelayMs = promptDelayMs;
    this.jobs = new Map();
  }

  start({ accountId, cwd, launch, title, prompt }) {
    const id = crypto.randomUUID().slice(0, 8);
    const info = { id, accountId, cwd, title, state: 'working', startedAt: Date.now(), exitCode: null };
    const proc = this.spawn(launch.file, launch.args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd,
      env: launch.env,
      useConpty: true,
    });
    const job = {
      info, proc, scrollback: '', exited: false,
      idleTimer: null, promptTimer: null, promptPending: prompt ? prompt : null,
    };
    this.jobs.set(id, job);

    proc.onData((chunk) => {
      if (job.exited) return;
      this._append(job, chunk);
      this._setState(job, 'working');
      clearTimeout(job.idleTimer);
      job.idleTimer = setTimeout(() => this._setState(job, 'idle'), this.idleMs);
      if (job.promptPending !== null) {
        clearTimeout(job.promptTimer);
        job.promptTimer = setTimeout(() => {
          const text = job.promptPending;
          job.promptPending = null;
          if (!job.exited) proc.write(text + '\r');
        }, this.promptDelayMs);
      }
      this.emit('data', id, chunk);
    });
    proc.onExit(({ exitCode }) => this._onExit(job, exitCode ?? 0));
    return { ...info };
  }

  _append(job, chunk) {
    let s = job.scrollback + chunk;
    if (s.length > this.scrollbackBytes) {
      s = s.slice(s.length - this.scrollbackBytes);
      const c = s.charCodeAt(0);
      if (c >= 0xdc00 && c <= 0xdfff) s = s.slice(1); // don't start on a lone low surrogate
    }
    job.scrollback = s;
  }

  _setState(job, state) {
    if (job.exited || job.info.state === state) return;
    job.info.state = state;
    this.emit('state', job.info.id, state);
  }

  _onExit(job, exitCode) {
    if (job.exited) return;
    job.exited = true;
    clearTimeout(job.idleTimer);
    clearTimeout(job.promptTimer);
    job.promptPending = null;
    job.info.exitCode = exitCode;
    job.info.state = exitCode === 0 ? 'done' : 'error';
    this.emit('state', job.info.id, job.info.state);
    this.emit('exit', job.info.id, exitCode);
  }

  _get(id) {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Unknown job ${id}`);
    return job;
  }

  list() {
    return [...this.jobs.values()].map((j) => ({ ...j.info }));
  }

  attach(id) {
    const job = this._get(id);
    return { info: { ...job.info }, scrollback: job.scrollback };
  }

  write(id, data) {
    const job = this._get(id);
    if (!job.exited) job.proc.write(data);
  }

  resize(id, cols, rows) {
    const job = this._get(id);
    if (!job.exited) job.proc.resize(cols, rows);
  }

  kill(id) {
    const job = this.jobs.get(id);
    if (!job) return;
    this.jobs.delete(id);
    // Always kill: even after a natural exit this releases the ConPTY handles that keep node alive.
    try { job.proc.kill(); } catch { /* already gone */ }
    this._onExit(job, job.info.exitCode ?? 1);
  }

  async killAll() {
    const jobs = [...this.jobs.values()];
    const waits = jobs.map((job) => new Promise((resolve) => {
      if (job.exited) return resolve();
      const timer = setTimeout(resolve, KILL_TIMEOUT_MS);
      const onExit = (id) => {
        if (id !== job.info.id) return;
        clearTimeout(timer);
        this.off('exit', onExit);
        resolve();
      };
      this.on('exit', onExit);
    }));
    for (const job of jobs) this.kill(job.info.id);
    await Promise.all(waits);
  }
}
