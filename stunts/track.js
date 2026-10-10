// Track pieces on a tile grid. A track is a sequence of piece codes laid down by a turtle, so pieces
// always connect. Each piece is a centreline in local (lateral, height, forward) coordinates; the road
// is swept along it. Produces render geometry, collision triangles and a sampled centreline.
'use strict';
(function (root) {
  const T = 40;           // tile size, metres
  const W = 12;           // road width
  const SHOULDER = 1.2;
  const RAMP_H = 5.5, LAND_H = 4.5, LOOP_R = 10.5, LOOP_SHIFT = W + 2;
  const DIRS = [[0, 1], [-1, 0], [0, -1], [1, 0]]; // +z, -x, -z, +x ; index+1 = turn right
  const smooth = x => x * x * (3 - 2 * x);

  // occupy: tile offsets [forward, right]; next: [forward, right]; turn: +1 right, -1 left
  const PIECES = {
    S: { name: 'Straight', occupy: [[0, 0]], next: [1, 0], turn: 0, len: T, at: u => [0, 0, u * T] },
    F: { name: 'Start / finish', occupy: [[0, 0]], next: [1, 0], turn: 0, len: T, at: u => [0, 0, u * T], finish: true },
    R: { name: 'Sharp right', occupy: [[0, 0]], next: [0, 1], turn: 1, len: Math.PI * T / 4, at: u => arc(u, T / 2, 1), curve: true },
    L: { name: 'Sharp left', occupy: [[0, 0]], next: [0, -1], turn: -1, len: Math.PI * T / 4, at: u => arc(u, T / 2, -1), curve: true },
    RR: { name: 'Wide right', occupy: [[0, 0], [1, 0], [0, 1], [1, 1]], next: [1, 2], turn: 1, len: Math.PI * 1.5 * T / 2, at: u => arc(u, 1.5 * T, 1), curve: true },
    LL: { name: 'Wide left', occupy: [[0, 0], [1, 0], [0, -1], [1, -1]], next: [1, -2], turn: -1, len: Math.PI * 1.5 * T / 2, at: u => arc(u, 1.5 * T, -1), curve: true },
    O: { name: 'Loop', occupy: [[0, 0], [1, 0]], next: [2, 0], turn: 0, len: 2 * T + 2 * Math.PI * LOOP_R, at: loop, loop: true, minSpeed: 27 },
    J: { name: 'Ramp', occupy: [[0, 0]], next: [1, 0], turn: 0, len: T, at: u => [0, RAMP_H * u * u, u * T], ramp: true, minSpeed: 31 },
    G: { name: 'Gap', occupy: [[0, 0]], next: [1, 0], turn: 0, len: T, at: u => [0, RAMP_H + (LAND_H - RAMP_H) * u, u * T], gap: true, minSpeed: 31 },
    D: { name: 'Landing', occupy: [[0, 0]], next: [1, 0], turn: 0, len: T, at: u => [0, LAND_H * (1 - u) * (1 - u), u * T], ramp: true },
  };
  function arc(u, R, side) {
    const th = u * Math.PI / 2;
    return [side * (R - R * Math.cos(th)), 0, R * Math.sin(th)];
  }
  // Loop over two tiles: run-up, a full vertical circle that drifts sideways so the exit clears the entry, run-out
  function loop(u) {
    const a = T, c = 2 * Math.PI * LOOP_R, total = 2 * a + c, s = u * total, half = LOOP_SHIFT / 2;
    if (s < a) { const k = s / a; return [-half * smooth(k), 0, s]; }
    if (s < a + c) {
      const th = (s - a) / LOOP_R;
      return [-half + LOOP_SHIFT * smooth(th / (2 * Math.PI)), LOOP_R * (1 - Math.cos(th)), a + LOOP_R * Math.sin(th)];
    }
    const k = (s - a - c) / a;
    return [half * (1 - smooth(k)), 0, a + k * a];
  }

  const TRACKS = [
    { name: 'Hollow Farm', code: 'S F S O S RR S S J G D S RR S S S S S S RR S S RR S' },
    { name: 'Twin Barns', code: 'S F S S R S J G D S R S S O S S R S S S S S S S R S S' },
  ];

  function layout(code) {
    let tx = 0, tz = 0, d = 0;
    const pieces = [], occ = new Map();
    for (const c of code.trim().split(/\s+/)) {
      const P = PIECES[c]; if (!P) throw new Error('Unknown piece ' + c);
      const f = DIRS[d], r = DIRS[(d + 1) & 3];
      for (const [of, or] of P.occupy) {
        const k = (tx + f[0] * of + r[0] * or) + ',' + (tz + f[1] * of + r[1] * or);
        if (occ.has(k)) throw new Error('Track overlaps itself at ' + k);
        occ.set(k, pieces.length);
      }
      // entry point: middle of the tile edge we come in through
      const origin = [tx * T - f[0] * T / 2, 0, tz * T - f[1] * T / 2];
      pieces.push({ code: c, P, tx, tz, d, origin, f: [f[0], 0, f[1]], r: [r[0], 0, r[1]] });
      tx += f[0] * P.next[0] + r[0] * P.next[1];
      tz += f[1] * P.next[0] + r[1] * P.next[1];
      d = (d + P.turn + 4) & 3;
    }
    const closed = tx === 0 && tz === 0 && d === 0;
    return { pieces, occ, closed, end: [tx, tz, d] };
  }

  function toWorld(pc, l) {
    return [pc.origin[0] + pc.r[0] * l[0] + pc.f[0] * l[2], l[1], pc.origin[2] + pc.r[2] * l[0] + pc.f[2] * l[2]];
  }

  class Track {
    constructor(def) {
      this.name = def.name;
      const L = layout(def.code);
      if (!L.closed) throw new Error(def.name + ' does not close; ends at ' + L.end);
      this.pieces = L.pieces; this.occ = L.occ;
      this.buildSamples();
      this.buildGeometry();
      this.buildGrid();
    }

    frameAt(pc, u) {
      const P = pc.P, e = 1e-3;
      const p = toWorld(pc, P.at(u));
      const a = toWorld(pc, P.at(Math.max(0, u - e))), b = toWorld(pc, P.at(Math.min(1, u + e)));
      const t = V.norm(V.sub(b, a));
      let right = P.loop ? pc.r : V.norm(V.cross(t, [0, 1, 0]));
      let up = V.norm(V.cross(right, t));
      right = V.norm(V.cross(t, up));
      return { p, t, up, right };
    }

    // Centreline samples about every metre: used for progress, AI and respawn
    buildSamples() {
      const S = []; let s = 0;
      this.pieces.forEach((pc, i) => {
        const n = Math.max(4, Math.ceil(pc.P.len / 1.0));
        pc.sampleStart = S.length;
        for (let k = 0; k < n; k++) {
          const fr = this.frameAt(pc, k / n);
          if (S.length) s += V.len(V.sub(fr.p, S[S.length - 1].p));
          S.push({ ...fr, s, piece: i, minSpeed: pc.P.minSpeed || 0, air: !!pc.P.gap });
        }
      });
      this.length = s + V.len(V.sub(S[0].p, S[S.length - 1].p));
      // Speed limit from horizontal curvature, ignoring vertical sections
      for (let i = 0; i < S.length; i++) {
        const a = S[(i - 2 + S.length) % S.length], b = S[(i + 2) % S.length];
        const flat = Math.abs(a.t[1]) < 0.6 && Math.abs(b.t[1]) < 0.6 && !this.pieces[S[i].piece].P.loop;
        let k = 0;
        if (flat) {
          const ya = Math.atan2(a.t[0], a.t[2]), yb = Math.atan2(b.t[0], b.t[2]);
          let dy = yb - ya; while (dy > Math.PI) dy -= 2 * Math.PI; while (dy < -Math.PI) dy += 2 * Math.PI;
          k = Math.abs(dy) / Math.max(0.5, V.len(V.sub(b.p, a.p)));
        }
        S[i].vmax = k > 1e-4 ? Math.sqrt(9.81 * 1.05 / k) : 999;
      }
      this.samples = S;
      this.lineS = S[this.pieces[1].sampleStart].s + 1;   // finish line sits at the start of piece 1
    }

    buildGeometry() {
      const vis = [], col = [], tris = [];
      const quad = (a, b, c, d, rgb, collide, surf) => {
        vis.push(...a, ...b, ...c, ...a, ...c, ...d);
        for (let i = 0; i < 6; i++) col.push(...rgb);
        if (collide) { tris.push([a, b, c, surf], [a, c, d, surf]); }
      };
      const ASPH = [0.38, 0.38, 0.41], ASPH2 = [0.35, 0.35, 0.38], LINE = [0.92, 0.92, 0.88], SH = [0.62, 0.6, 0.55];
      const KR = [0.82, 0.12, 0.1], KW = [0.95, 0.95, 0.95], WALL = [0.55, 0.53, 0.5], WALL2 = [0.45, 0.43, 0.42];
      const lift = 0.04;
      this.pieces.forEach(pc => {
        const P = pc.P; if (P.gap) return;
        const n = Math.max(4, Math.ceil(P.len / (P.loop ? 0.8 : 1.5)));
        let prev = null, dist = 0;
        for (let k = 0; k <= n; k++) {
          const fr = this.frameAt(pc, k / n);
          const at = lat => V.add(V.madd(fr.p, fr.right, lat), V.scale(fr.up, lift));
          const cur = { fr, at };
          if (prev) {
            dist += V.len(V.sub(fr.p, prev.fr.p));
            const stripe = Math.floor(dist / 3) & 1;
            // lateral bands: shoulder | edge line | asphalt | centre dash | asphalt | edge line | shoulder
            const h = W / 2, bands = [
              [-h - SHOULDER, -h, P.curve ? (stripe ? KR : KW) : SH, 1],
              [-h, -h + 0.45, LINE, 0], [-h + 0.45, -0.15, stripe ? ASPH : ASPH2, 0],
              [-0.15, 0.15, (Math.floor(dist / 4) & 1) ? LINE : ASPH, 0],
              [0.15, h - 0.45, stripe ? ASPH : ASPH2, 0], [h - 0.45, h, LINE, 0],
              [h, h + SHOULDER, P.curve ? (stripe ? KR : KW) : SH, 1]];
            for (const [a, b, rgb, surf] of bands) {
              let c = rgb;
              if (P.finish && dist < 4) c = ((Math.floor((a + 8) / 1.5) + Math.floor(dist / 1.5)) & 1) ? [0.05, 0.05, 0.05] : KW;
              quad(prev.at(a), prev.at(b), cur.at(b), cur.at(a), c, true, surf);
            }
            // underside so loops and ramps look solid from below
            const under = lat => V.madd(V.madd(fr.p, fr.right, lat), fr.up, -0.5);
            const underP = lat => V.madd(V.madd(prev.fr.p, prev.fr.right, lat), prev.fr.up, -0.5);
            const e = h + SHOULDER;
            quad(underP(e), underP(-e), under(-e), under(e), WALL2, false);
            quad(underP(-e), prev.at(-e), cur.at(-e), under(-e), WALL, false);
            quad(prev.at(e), underP(e), under(e), cur.at(e), WALL, false);
            // ramp walls down to the ground
            if (P.ramp) {
              for (const side of [-1, 1]) {
                const top0 = prev.at(side * e), top1 = cur.at(side * e);
                const g0 = [top0[0], 0, top0[2]], g1 = [top1[0], 0, top1[2]];
                if (side < 0) quad(g0, top0, top1, g1, WALL, false); else quad(top0, g0, g1, top1, WALL, false);
              }
            }
          }
          prev = cur;
        }
      });
      this.visPos = new Float32Array(vis); this.visCol = new Float32Array(col);
      this.tris = tris.map(([a, b, c, surf]) => {
        const e1 = V.sub(b, a), e2 = V.sub(c, a);
        return { a, e1, e2, n: V.norm(V.cross(e1, e2)), surf };
      });
    }

    buildGrid() {
      this.cell = 8; this.grid = new Map();
      this.tris.forEach((t, i) => {
        const xs = [t.a[0], t.a[0] + t.e1[0], t.a[0] + t.e2[0]], zs = [t.a[2], t.a[2] + t.e1[2], t.a[2] + t.e2[2]];
        const x0 = Math.floor(Math.min(...xs) / this.cell), x1 = Math.floor(Math.max(...xs) / this.cell);
        const z0 = Math.floor(Math.min(...zs) / this.cell), z1 = Math.floor(Math.max(...zs) / this.cell);
        for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
          const k = x * 100003 + z; let a = this.grid.get(k); if (!a) this.grid.set(k, a = []); a.push(i);
        }
      });
    }

    // One-sided raycast against the road plus the ground plane (y = 0). surf: 0 road, 1 kerb, 2 grass
    raycast(o, d, maxT) {
      let best = null;
      if (d[1] < -1e-6 && o[1] >= 0) {
        const t = -o[1] / d[1];
        if (t <= maxT) best = { t, n: [0, 1, 0], surf: 2 };
      }
      const e = V.madd(o, d, maxT), c = this.cell;
      const x0 = Math.floor(Math.min(o[0], e[0]) / c), x1 = Math.floor(Math.max(o[0], e[0]) / c);
      const z0 = Math.floor(Math.min(o[2], e[2]) / c), z1 = Math.floor(Math.max(o[2], e[2]) / c);
      const seen = this._seen || (this._seen = new Set()); seen.clear();
      for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
        const list = this.grid.get(x * 100003 + z); if (!list) continue;
        for (const i of list) {
          if (seen.has(i)) continue; seen.add(i);
          const tr = this.tris[i];
          const p = V.cross(d, tr.e2), det = V.dot(tr.e1, p);
          if (det < 1e-9) continue;
          const inv = 1 / det, s = V.sub(o, tr.a), u = V.dot(s, p) * inv;
          if (u < 0 || u > 1) continue;
          const q = V.cross(s, tr.e1), v = V.dot(d, q) * inv;
          if (v < 0 || u + v > 1) continue;
          const t = V.dot(tr.e2, q) * inv;
          if (t >= 0 && t <= maxT && (!best || t < best.t)) best = { t, n: tr.n, surf: tr.surf };
        }
      }
      if (best) best.p = V.madd(o, d, best.t);
      return best;
    }

    // Nearest centreline sample, searching near a previous index
    nearest(pos, hint, win = 70) {
      const S = this.samples, n = S.length;
      let bi = -1, bd = Infinity;
      const scan = (from, to) => {
        for (let k = from; k <= to; k++) {
          const i = ((k % n) + n) % n, d = V.sub(pos, S[i].p), dd = d[0] * d[0] + d[1] * d[1] * 2 + d[2] * d[2];
          if (dd < bd) { bd = dd; bi = i; }
        }
      };
      if (hint == null) scan(0, n - 1); else scan(hint - win, hint + win);
      return { i: bi, d: Math.sqrt(bd) };
    }
  }

  root.Track = Track; root.TRACKS = TRACKS; root.PIECES = PIECES; root.TILE = T; root.ROAD_W = W; root.layoutTrack = layout;
})(typeof window !== 'undefined' ? window : globalThis);
