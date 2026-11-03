// Particle orb, ported from design/jarvis-mockup.html.
// One shape per account; points morph between shapes, frame-rate independent.

const TAU = Math.PI * 2;
const rnd = Math.random;
const gauss = () => {
  let u = 0;
  let v = 0;
  while (!u) u = rnd();
  while (!v) v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v);
};

const rotX = (p, a) => [p[0], p[1] * Math.cos(a) - p[2] * Math.sin(a), p[1] * Math.sin(a) + p[2] * Math.cos(a)];
const rotY = (p, a) => [p[0] * Math.cos(a) - p[2] * Math.sin(a), p[1], p[0] * Math.sin(a) + p[2] * Math.cos(a)];
const rotZ = (p, a) => [p[0] * Math.cos(a) - p[1] * Math.sin(a), p[0] * Math.sin(a) + p[1] * Math.cos(a), p[2]];

// how each shape spins, how white it glows, whether it draws constellation lines
const STYLE = {
  claude: { spin: (p, a) => rotX(rotZ(p, a * 0.35), 0.18), white: 0.45, lines: 0 },
  work: { spin: (p, a) => rotX(rotZ(p, -a * 1.6), 0.25), white: 0.75, lines: 0 },
  mine: { spin: (p, a) => rotX(rotZ(p, -a * 1.6), 0.25), white: 0.75, lines: 0 },
  gemini: { spin: (p, a) => rotZ(p, a * 0.6), white: 0.5, lines: 0 },
};

// Fixed ray lengths (not random) so the burst keeps the same silhouette every load.
const RAYS = [1.0, 0.82, 0.94, 0.78, 0.98, 0.86, 0.92, 0.8, 1.02, 0.84, 0.9, 0.79];
function burstPoint(i) {
  const k = i % RAYS.length;
  const ang = (k / RAYS.length) * TAU + 0.12 * Math.sin(k * 2.3);
  const len = RAYS[k];
  const start = 0.16;
  const d = start + Math.pow(rnd(), 0.85) * (len - start);
  const t = (d - start) / (len - start); // 0 at the centre end, 1 at the tip
  const half = 0.05 * Math.sin(Math.PI * Math.min(1, 0.2 + t * 0.85)) + 0.018; // rounded ends, fuller middle
  const w = (rnd() + rnd() - 1) * half; // denser along the middle of each ray
  return [Math.cos(ang) * d - Math.sin(ang) * w, Math.sin(ang) * d + Math.cos(ang) * w, gauss() * 0.025];
}

function buildShapes(N) {
  const S = { claude: [], work: [], mine: [], gemini: [] };
  for (let i = 0; i < N; i++) {
    // Claude: a radiant burst like its icon: 12 rounded rays of uneven length around a small open centre
    S.claude.push(burstPoint(i));
    // Codex work: two-arm spiral galaxy with a bright core
    if (i < N * 0.12) {
      const k = 0.1;
      S.work.push([gauss() * k, gauss() * k, gauss() * k * 0.4]);
    } else {
      const arm = i % 2;
      const d = Math.pow(rnd(), 0.8);
      const a = arm * Math.PI + d * 2.6 * Math.PI + gauss() * 0.07;
      const rr = 0.1 + d * 1.0;
      const sp = 0.015 + 0.035 * d;
      S.work.push([Math.cos(a) * rr + gauss() * sp, Math.sin(a) * rr + gauss() * sp, gauss() * 0.02]);
    }
    // Codex personal: the same two-arm spiral galaxy
    S.mine.push(S.work[i].slice());
    // Gemini: four-pointed star
    const ray = i % 4;
    const dd = Math.pow(rnd(), 0.9);
    const wdt = (1 - dd) * (1 - dd) * 0.32 * gauss();
    const ra = (ray * Math.PI) / 2;
    const L = 1.05 * dd;
    S.gemini.push([Math.cos(ra) * L - Math.sin(ra) * wdt, Math.sin(ra) * L + Math.cos(ra) * wdt, gauss() * 0.02]);
  }
  return S;
}

function neighbours(points) {
  const N = points.length;
  return points.map((p, i) => {
    const d = [];
    for (let j = 0; j < N; j++) {
      if (j === i) continue;
      const q = points[j];
      d.push([j, (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2]);
    }
    d.sort((a, b) => a[1] - b[1]);
    return [d[0][0], d[1][0]];
  });
}

export function createOrb(canvas, { shape: initialShape = 'claude', rgb = [224, 96, 154], pauseButton } = {}) {
  const cx = canvas.getContext('2d');
  const W = canvas.width;
  const R = W * 0.43;
  const N = 1100;
  const S = buildShapes(N);
  const NB = neighbours(S.claude);

  let shape = Object.hasOwn(STYLE, initialShape) ? initialShape : 'claude';
  const pos = S[shape].map((p) => p.slice());
  let white = STYLE[shape].white;
  let lines = STYLE[shape].lines;
  const cur = rgb.slice();
  let target = rgb.slice();
  let ang = 0;
  let run = !matchMedia('(prefers-reduced-motion: reduce)').matches;
  let last = performance.now();
  let rafId = 0;

  const syncPauseLabel = () => {
    if (pauseButton) pauseButton.textContent = run ? 'Pause motion' : 'Resume motion';
  };
  if (pauseButton) {
    syncPauseLabel();
    pauseButton.addEventListener('click', () => {
      run = !run;
      syncPauseLabel();
    });
  }

  function frame(now = performance.now()) {
    const f = Math.min(30, (now - last) / 16.7);
    last = now;
    for (let k = 0; k < 3; k++) cur[k] += (target[k] - cur[k]) * (1 - Math.pow(0.94, f));
    const st = STYLE[shape];
    white += (st.white - white) * (1 - Math.pow(0.95, f));
    lines += (st.lines - lines) * (1 - Math.pow(0.92, f));
    if (run) ang += 0.0025 * f;
    const base = S[shape];
    for (let i = 0; i < N; i++) {
      const t = st.spin(base[i], ang);
      const p = pos[i];
      // stagger so points peel off one after another
      const s = 1 - Math.pow(1 - (0.035 + (0.05 * ((i * 7919) % N)) / N), f);
      p[0] += (t[0] - p[0]) * s;
      p[1] += (t[1] - p[1]) * s;
      p[2] += (t[2] - p[2]) * s;
    }
    const [r, g, b] = cur;
    cx.clearRect(0, 0, W, W);
    cx.globalCompositeOperation = 'lighter';
    const breathe = 1 + 0.015 * Math.sin(ang * 12);
    const Q = pos.map((p) => [W / 2 + p[0] * R * breathe, W / 2 + p[1] * R * breathe, p[2]]);
    if (lines > 0.02) {
      cx.lineWidth = 0.6;
      for (let i = 0; i < N; i++) {
        const a = Q[i];
        if (a[2] < -0.2) continue;
        for (const j of NB[i]) {
          const c = Q[j];
          cx.strokeStyle = `rgba(${r | 0},${g | 0},${b | 0},${(0.12 + (0.35 * (a[2] + 1)) / 2) * lines})`;
          cx.beginPath();
          cx.moveTo(a[0], a[1]);
          cx.lineTo(c[0], c[1]);
          cx.stroke();
        }
      }
    }
    for (const a of Q) {
      const d = Math.max(0, Math.min(1, (a[2] + 1) / 2));
      const w = white * (0.5 + 0.5 * d);
      cx.fillStyle = `rgba(${(r + (255 - r) * w) | 0},${(g + (255 - g) * w) | 0},${(b + (255 - b) * w) | 0},${0.3 + 0.7 * d})`;
      cx.beginPath();
      cx.arc(a[0], a[1], 0.7 + 2.2 * d, 0, 7);
      cx.fill();
    }
    rafId = requestAnimationFrame(frame);
  }

  function start() {
    if (rafId) return;
    last = performance.now();
    rafId = requestAnimationFrame(frame);
  }
  function stop() {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }

  // Don't burn CPU while the window is hidden or minimised.
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
  if (!document.hidden) start();

  return {
    setShape(k) {
      if (Object.hasOwn(STYLE, k)) shape = k;
    },
    setColor(next) {
      target = next.slice();
    },
  };
}
