// Autopilot for headless tests (qa.mjs): drives a full lap of TESTB (the TESTER track with its two middle pieces made
// straight road; stunts/tracks, not in git) by its centre line, pressing the arrow keys as a player would, and returns
// when the car finishes (or after window.__autoMs). Use as one qa step: { "eval": <this file's text> }, with
// window.__steerSign = -1 set first. Real laps for ghost tests: the first finish keeps a ghost, the next race shows it.
// Track pieces: column c is x = (c + 0.5) * 1024, row r is z = -(r + 0.5) * 1024; a car's forward is -(Wm[2], Wm[10]).
(async () => {
  const T = 1024, X = c => (c + 0.5) * T, Z = r => -(r + 0.5) * T;
  const pts = [];
  for (let r = 8; r <= 17; r += 0.25) pts.push([X(6), Z(r)]);
  for (let c = 6; c <= 7; c += 0.25) pts.push([X(c), Z(17)]);
  for (let r = 17; r >= 7; r -= 0.25) pts.push([X(7), Z(r)]);
  for (let c = 7; c >= 6; c -= 0.25) pts.push([X(c), Z(7)]);
  for (let r = 7; r <= 9; r += 0.25) pts.push([X(6), Z(r)]);
  const key = (code, down) => dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code, key: code }));
  const D = StuntsCode.DSEG << 4, S = StuntsCode.SYM, rw = a => mem[a] | mem[a + 1] << 8;
  const mph = () => rw(D + S.state + 0x152 + 0x2C) / 256, flag = () => mem[D + ((S.state + 0x152 + 0xC9) & 0xFFFF)];
  const me = () => view.cur && view.cur.objs.find(o => view.carIdx && view.carIdx.get(o.ptr) === 2);
  let held = { ArrowLeft: false, ArrowRight: false, ArrowUp: false, ArrowDown: false };
  const set = (k, v) => { if (held[k] !== v) { held[k] = v; key(k, v); } };
  let idx = 0, prev = null, log = [], t0 = performance.now(), sign = window.__steerSign || 1;
  while (performance.now() - t0 < (window.__autoMs || 150000)) {
    await new Promise(r => setTimeout(r, 40));
    const o = me(); if (!o) continue;
    const x = o.Wm[3], z = o.Wm[11];
    if (flag() === 3) { log.push('finish'); break; }
    // nearest point ahead
    let best = idx, bd = 1e18;
    for (let i = idx; i < Math.min(pts.length, idx + 8); i++) { const d = (pts[i][0] - x) ** 2 + (pts[i][1] - z) ** 2; if (d < bd) { bd = d; best = i; } }
    idx = best;
    const tgt = pts[Math.min(pts.length - 1, idx + 3)];
    const fx = -o.Wm[2], fz = -o.Wm[10];   // car forward (guess)
    const tx = tgt[0] - x, tz = tgt[1] - z, tl = Math.hypot(tx, tz) || 1;
    const cross = (fx * tz - fz * tx) / tl, dot = (fx * tx + fz * tz) / tl;
    const ang = Math.atan2(cross, dot) * sign;
    set('ArrowLeft', ang > 0.06); set('ArrowRight', ang < -0.06);
    const want = Math.abs(ang) > 0.3 ? 18 : 45;
    const v = mph(); set('ArrowUp', v < want); set('ArrowDown', v > want + 12);
    if (log.length < 400 && Math.random() < 0.05) log.push([Math.round(x), Math.round(z), idx, +ang.toFixed(2), Math.round(v)].join(','));
  }
  for (const k in held) set(k, false);
  return JSON.stringify({ idx, n: pts.length, flag: flag(), log: log.slice(-25) });
})()
