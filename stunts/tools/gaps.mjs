// Geometry gap check: finds where a shape lets you see through it (the sky under a roof, through a seam between
// a wall and its roof). The game draws most faces one-sided; from behind they are not drawn. A face whose back
// can be seen from somewhere outside the shape (above the ground), with nothing drawn in front of it, is a hole
// in the picture. Rays leave each one-sided face's back; one that gets out to open air past only faces not drawn
// from that side is a leak.
//
// In the page (a race or the track menu running, so the shapes are loaded):
//   const g = await import('/stunts/tools/gaps.mjs'); g.scan(view)          every scenery shape: [{ i, ptr, tris, leaks, faces }]
//   g.scan(view, { only: [i] })                                               one shape, with the leaking points
// From the shell: node stunts/tools/qa.mjs with a script whose "eval" step runs it (stunts/tools/gaps.json).

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

// as hires-view's viewSector: the original's 32 view sectors (a face's cull2 bit for one draws it from both sides)
function viewSector(x, y, z) {
  const h = Math.hypot(x, z);
  if (h < Math.abs(y)) return y < 0 ? 30 : 31;
  let ang = -Math.round(Math.atan2(z, -x) * 512 / Math.PI);
  if (ang < 0) ang += 1024;
  return (y > 0 ? 15 : 0) + ((ang * 15) >> 10);
}

// directions over a sphere (Fibonacci), each ray picks those on its face's back
const DIRS = (() => { const n = 160, out = []; for (let i = 0; i < n; i++) { const y = 1 - 2 * (i + 0.5) / n, r = Math.sqrt(1 - y * y), f = i * Math.PI * (3 - Math.sqrt(5)); out.push([r * Math.cos(f), y, r * Math.sin(f)]); } return out; })();

// the shape's faces as triangles, in the renderer's axes (z mirrored), each with how it is drawn
export function faces(sh) {
  const T = [];
  for (const p of sh.prims) {
    if (!p.poly || p.decal || !p.tri || p.tri.length < 9) continue;
    const t = p.tri;
    for (let k = 0; k + 8 < t.length; k += 9) {
      const a = [t[k], t[k + 1], -t[k + 2]], b = [t[k + 3], t[k + 4], -t[k + 5]], c = [t[k + 6], t[k + 7], -t[k + 8]];
      const n = cross(sub(b, a), sub(c, a)), l = Math.hypot(...n);
      if (l < 1e-6) continue;
      T.push({ a, b, c, e1: sub(b, a), e2: sub(c, a), p, one: p.one && p.f3 ? 1 : 0, fn: p.f3 ? p.f3[1] : n.map(v => v / l), area: l / 2 });
    }
  }
  return T;
}

// is the face drawn seen from a camera far along d (the renderer's test: shown from the side opposite its normal)
function drawn(f, d) {
  if (!f.one) return true;
  if (dot(f.fn, d) < 0) return true;
  if (-d[1] <= 0) { const s = viewSector(-d[0], -d[1], d[2]); if ((f.p.cull2 >>> (31 - s)) & 1) return true; }
  return false;
}

function hit(o, d, f) {   // Moller-Trumbore; distance or -1
  const pv = cross(d, f.e2), det = dot(f.e1, pv);
  if (Math.abs(det) < 1e-9) return -1;
  const inv = 1 / det, tv = sub(o, f.a), u = dot(tv, pv) * inv;
  if (u < -1e-4 || u > 1 + 1e-4) return -1;
  const qv = cross(tv, f.e1), v = dot(d, qv) * inv;
  if (v < -1e-4 || u + v > 1 + 1e-4) return -1;
  const t = dot(f.e2, qv) * inv;
  return t > 1e-3 ? t : -1;
}

// one shape: the points on one-sided faces whose back shows from outside, with the direction it shows towards
export function leaks(sh, opt = {}) {
  const F = faces(sh), out = [];
  if (!F.length) return { tris: 0, leaks: out };
  let ground = Infinity; for (const f of F) for (const v of [f.a, f.b, f.c]) ground = Math.min(ground, v[1]);
  ground = opt.ground != null ? opt.ground : ground;
  const S = opt.samples || [[1 / 3, 1 / 3], [0.1, 0.1], [0.8, 0.1], [0.1, 0.8], [0.45, 0.45], [0.05, 0.475], [0.475, 0.05]];
  for (const f of F) {
    if (!f.one) continue;
    for (const [u, v] of S) {
      const p = [0, 1, 2].map(k => f.a[k] + f.e1[k] * u + f.e2[k] * v);
      if (p[1] < ground + 1) continue;   // (at the ground: under it no one looks)
      const o = [p[0] + f.fn[0] * 0.05, p[1] + f.fn[1] * 0.05, p[2] + f.fn[2] * 0.05];
      for (const d of DIRS) {
        if (dot(d, f.fn) <= 0.05 || drawn(f, d)) continue;
        if (d[1] < 0 && (o[1] - ground) / -d[1] < 1e5) {
          // (the ground stops a ray going down: a camera there would be under the ground; only far enough out does it count)
          const tg = (o[1] - ground) / -d[1];
          let blocked = false; for (const g of F) { if (g === f) continue; const t = hit(o, d, g); if (t > 0 && t < tg && drawn(g, d)) { blocked = true; break; } }
          if (blocked || tg < 40) continue;
        } else {
          let blocked = false; for (const g of F) { if (g === f) continue; const t = hit(o, d, g); if (t > 0 && drawn(g, d)) { blocked = true; break; } }
          if (blocked) continue;
        }
        out.push({ prim: f.p.idx, p: p.map(x => Math.round(x)), d: d.map(x => +x.toFixed(2)) });
      }
    }
  }
  return { tris: F.length, leaks: out };
}

// every scenery shape the game has loaded (game3dshapes; 124.. are the cars)
export function scan(view, opt = {}) {
  const base = view.S.game3dshapes, res = [];
  const idx = opt.only || Array.from({ length: 124 }, (_, i) => i);
  for (const i of idx) {
    const ptr = base + i * 22;
    let sh; try { sh = view.shape(ptr, 0); } catch (e) { continue; }
    if (!sh || !sh.prims || !sh.prims.length) continue;
    const r = leaks(sh, opt);
    if (!r.tris) continue;
    const by = {}; for (const l of r.leaks) by[l.prim] = (by[l.prim] || 0) + 1;
    const bb = sh.bb && sh.bb.map(Math.round);
    res.push({ i, ptr, tris: r.tris, bb, leaks: r.leaks.length, faces: by, at: opt.only ? r.leaks : undefined });
  }
  return res;
}

// The whole track as it stands (every static piece where it is placed): where two faces that should meet do not. A
// crack: an open edge (one only a single triangle has, across all the pieces) above the ground, running alongside
// another open edge close by (parallel, overlapping) without touching it, and on no other face: the sky shows
// between them. [{ at, gap, len, shapes, same }] (gap in world units, len how long, shapes the game3dshapes indices of
// the two pieces, same: both edges in one piece), the widest first.
//   g.seams(view)    g.seams(view, { max: 20 })
export function seams(view, opt = {}) {
  const T = window.THREE, MAX = opt.max || 20, ON = opt.on || 0.35, base = view.S.game3dshapes;
  const tris = [], M = new T.Matrix4(), v = new T.Vector3();
  for (const im of view.statics.children) {
    if (!im.isInstancedMesh) continue;
    const g = im.geometry, P = g.attributes.position.array, L = g.attributes.lofs && g.attributes.lofs.array, pat = g.attributes.pat.array;
    const shape = im.userData.hi != null ? (im.userData.hi - base) / 22 : -1;
    for (let i = 0; i < im.count; i++) {
      im.getMatrixAt(i, M);
      if (Math.abs(M.elements[0]) + Math.abs(M.elements[1]) + Math.abs(M.elements[2]) < 1e-6) continue;   // (taken up near the camera)
      for (let k = 0; k + 2 < P.length / 3; k += 3) {
        if (L && (L[k * 3] || L[k * 3 + 1] || L[k * 3 + 2])) continue;   // (lines: thin tubes)
        if (pat[k] === 0) continue;
        const t = [];
        for (let j = 0; j < 3; j++) { v.set(P[(k + j) * 3], P[(k + j) * 3 + 1], P[(k + j) * 3 + 2]).applyMatrix4(M); t.push([v.x, v.y, v.z]); }
        tris.push({ t, piece: im.id * 4096 + i, shape });
      }
    }
  }
  const C = 128, cell = (x, z) => Math.floor(x / C) + ':' + Math.floor(z / C);
  const put = (grid, lo, hi, n) => { for (let x = Math.floor((lo[0] - MAX) / C); x <= Math.floor((hi[0] + MAX) / C); x++) for (let z = Math.floor((lo[1] - MAX) / C); z <= Math.floor((hi[1] + MAX) / C); z++) { const k = x + ':' + z; if (!grid.has(k)) grid.set(k, []); grid.get(k).push(n); } };
  const tgrid = new Map();
  tris.forEach((q, n) => { const xs = q.t.map(p => p[0]), zs = q.t.map(p => p[2]); put(tgrid, [Math.min(...xs), Math.min(...zs)], [Math.max(...xs), Math.max(...zs)], n); });
  // open edges: counted across everything, endpoints to a quarter unit
  const key = p => Math.round(p[0] * 4) + ',' + Math.round(p[1] * 4) + ',' + Math.round(p[2] * 4);
  const edges = new Map();
  tris.forEach((q, n) => { for (let j = 0; j < 3; j++) { const a = q.t[j], b = q.t[(j + 1) % 3], ka = key(a), kb = key(b), k = ka < kb ? ka + '|' + kb : kb + '|' + ka; const e = edges.get(k); if (e) e.n++; else edges.set(k, { n: 1, a, b, tri: n }); } });
  const open = [];
  for (const e of edges.values()) {
    if (e.n !== 1 || (e.a[1] < 1 && e.b[1] < 1)) continue;   // (on the ground: it covers what is under)
    const d = sub(e.b, e.a), len = Math.hypot(...d);
    if (len < 2) continue;
    // (along another face: it meets something there)
    const mid = [0, 1, 2].map(k => e.a[k] + d[k] / 2), own = tris[e.tri];
    if ((tgrid.get(cell(mid[0], mid[2])) || []).some(n => tris[n] !== own && distTri(mid, tris[n].t) <= ON)) continue;
    open.push({ ...e, u: d.map(x => x / len), len, piece: own.piece, shape: own.shape });
  }
  const egrid = new Map();
  open.forEach((e, n) => put(egrid, [Math.min(e.a[0], e.b[0]), Math.min(e.a[2], e.b[2])], [Math.max(e.a[0], e.b[0]), Math.max(e.a[2], e.b[2])], n));
  const out = [], seen = new Set();
  open.forEach((e, n) => {
    let best = null;
    const near = new Set(); for (const s of [0.25, 0.5, 0.75]) for (const m of egrid.get(cell(e.a[0] + (e.b[0] - e.a[0]) * s, e.a[2] + (e.b[2] - e.a[2]) * s)) || []) near.add(m);
    for (const m of near) {
      if (m === n) continue;
      const f = open[m];
      if (Math.abs(dot(e.u, f.u)) < 0.94) continue;
      // the two overlap along their length, and the gap between them over that overlap
      const t0 = dot(sub(f.a, e.a), e.u), t1 = dot(sub(f.b, e.a), e.u), lo = Math.max(0, Math.min(t0, t1)), hi = Math.min(e.len, Math.max(t0, t1));
      if (hi - lo < Math.min(2, e.len * 0.3)) continue;
      let gap = 0;
      for (const s of [0.1, 0.5, 0.9]) { const t = lo + (hi - lo) * s, p = [0, 1, 2].map(k => e.a[k] + e.u[k] * t); gap = Math.max(gap, distSeg(p, f.a, f.b)); }
      if (gap <= 0.05 || gap > MAX) continue;
      if (!best || gap < best.gap) best = { m, gap, ov: hi - lo, mid: [0, 1, 2].map(k => e.a[k] + e.u[k] * (lo + hi) / 2) };
    }
    if (!best) return;
    const k = Math.min(n, best.m) + ':' + Math.max(n, best.m);
    if (seen.has(k)) return; seen.add(k);
    const f = open[best.m];
    out.push({ at: best.mid.map(x => Math.round(x)), gap: +best.gap.toFixed(2), len: Math.round(best.ov), shapes: [e.shape, f.shape], same: e.piece === f.piece });
  });
  return out.sort((a, b) => b.gap - a.gap);
}

function distSeg(p, a, b) {
  const ab = sub(b, a), t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / dot(ab, ab)));
  return Math.hypot(p[0] - a[0] - ab[0] * t, p[1] - a[1] - ab[1] * t, p[2] - a[2] - ab[2] * t);
}

function distTri(p, t) {   // a point's distance to a triangle (Ericson's closest point)
  const [a, b, c] = t, ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
  const d1 = dot(ab, ap), d2 = dot(ac, ap); let q;
  if (d1 <= 0 && d2 <= 0) q = a;
  else {
    const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
    if (d3 >= 0 && d4 <= d3) q = b;
    else {
      const vc = d1 * d4 - d3 * d2;
      if (vc <= 0 && d1 >= 0 && d3 <= 0) { const w = d1 / (d1 - d3); q = [a[0] + ab[0] * w, a[1] + ab[1] * w, a[2] + ab[2] * w]; }
      else {
        const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
        if (d6 >= 0 && d5 <= d6) q = c;
        else {
          const vb = d5 * d2 - d1 * d6;
          if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); q = [a[0] + ac[0] * w, a[1] + ac[1] * w, a[2] + ac[2] * w]; }
          else {
            const va = d3 * d6 - d5 * d4;
            if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / (d4 - d3 + d5 - d6); q = [b[0] + (c[0] - b[0]) * w, b[1] + (c[1] - b[1]) * w, b[2] + (c[2] - b[2]) * w]; }
            else { const den = 1 / (va + vb + vc), vv = vb * den, ww = vc * den; q = [a[0] + ab[0] * vv + ac[0] * ww, a[1] + ab[1] * vv + ac[1] * ww, a[2] + ab[2] * vv + ac[2] * ww]; }
          }
        }
      }
    }
  }
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}
