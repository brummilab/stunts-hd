// Loads original Stunts 1.1 files from the local Restunts checkout and turns 3D shapes into
// Three.js geometry with the game's own palette and material colours.
// Converts Stunts' left-handed coordinates to Three.js by mirroring z.
'use strict';
(function (root) {
  const D = root.StuntsData;
  const DATA = '../vendor/restunts/stunts/';

  async function bin(name) {
    const r = await fetch(DATA + name);
    if (!r.ok) throw new Error('Could not load ' + name + ' from the Stunts data folder.');
    return new Uint8Array(await r.arrayBuffer());
  }
  const res = async name => D.parseRes(/\.(P3S|PVS|PRE)$/i.test(name) ? D.decompress(await bin(name)) : await bin(name));

  class StuntsAssets {
    async load() {
      this.tables = await (await fetch('gen/tables.json')).json();
      const [g1, g2, sd] = await Promise.all([res('GAME1.P3S'), res('GAME2.P3S'), res('SDMAIN.PVS')]);
      this.shapes = {};
      for (const [k, b] of Object.entries({ ...g1, ...g2 })) this.shapes[k] = D.parseShape(b);
      const p = sd['!pal'];
      this.palette = [];
      for (let i = 0; i < 256; i++) this.palette.push([p[16 + i * 3] / 63, p[17 + i * 3] / 63, p[18 + i * 3] / 63]);
      const mc = this.tables.material_color_list;
      this.matColor = [];
      for (let i = 0; i < mc.length; i += 2) this.matColor.push(mc[i] | (mc[i + 1] << 8));
      this.geoCache = new Map();
      return this;
    }
    async loadCar(id) {
      const [p3s, spec] = await Promise.all([res('ST' + id + '.P3S'), res('CAR' + id + '.RES')]);
      return { id, shape: D.parseShape(p3s.car1), menuShape: D.parseShape(p3s.car0), lo: D.parseShape(p3s.car2), spec: D.parseCar(spec.simd), info: spec };
    }
    // Original in-car dashboard sprites (STDA<car>.PVS) as RGBA image data in the game palette
    async loadDash(id) {
      const r = await res('STDA' + id + '.PVS'), out = {};
      for (const [k, b] of Object.entries(r)) {
        if (k[0] === '!') continue;
        const sp = D.parseShape2D(b), img = new ImageData(sp.w, sp.h);
        // In the dashboard itself colour 0 is black panel, except the windscreen gap reaching the top edge
        const see = new Uint8Array(sp.w * sp.h);
        if (k === 'dash') {
          const st = [];
          for (let x = 0; x < sp.w; x++) if (!sp.px[x]) { see[x] = 1; st.push(x); }
          while (st.length) {
            const i = st.pop(), x = i % sp.w, y = (i / sp.w) | 0;
            for (const j of [x > 0 ? i - 1 : -1, x < sp.w - 1 ? i + 1 : -1, y > 0 ? i - sp.w : -1, y < sp.h - 1 ? i + sp.w : -1])
              if (j >= 0 && !see[j] && !sp.px[j]) { see[j] = 1; st.push(j); }
          }
        } else see.fill(1);
        for (let i = 0; i < sp.w * sp.h; i++) {
          const c = sp.px[i]; if (!c && see[i]) continue;
          const p = this.palette[c]; img.data.set([p[0] * 255, p[1] * 255, p[2] * 255, 255], i * 4);
        }
        out[k] = { ...sp, img };
      }
      return out;
    }
    async loadTrack(name) { return D.parseTrack(await bin(name)); }
    // Horizon panorama: load_skybox reads strips scen, sce2, sce3, sce4 from the scenery file; laid side by
    // side they are 1024 px, one full turn in Stunts angle units. Bottom-aligned, colour 0 is sky.
    async loadHorizon(type) {
      const file = ['DESERT', 'TROPICAL', 'ALPINE', 'CITY', 'COUNTRY'][type] || 'COUNTRY';
      const r = await res(file + '.PVS');
      const strips = ['scen', 'sce2', 'sce3', 'sce4'].map(k => D.parseShape2D(r[k]));
      const W = strips.reduce((s, p) => s + p.w, 0), H = Math.max(...strips.map(p => p.h));
      const img = new ImageData(W, H);
      let x0 = 0;
      for (const p of strips) {
        for (let y = 0; y < p.h; y++) for (let x = 0; x < p.w; x++) {
          const c = p.px[y * p.w + x]; if (!c) continue;
          const q = this.palette[c], o = ((H - p.h + y) * W + x0 + x) * 4;
          img.data[o] = q[0] * 255; img.data[o + 1] = q[1] * 255; img.data[o + 2] = q[2] * 255; img.data[o + 3] = 255;
        }
        x0 += p.w;
      }
      // load_skybox: sky = material 0x11, ground = material 0x10, water = material 0x64
      return { img, w: W, h: H, sky: this.color(0x11), ground: this.color(0x10), water: this.color(0x64) };
    }
    color(material) {
      const pal = this.matColor[material] != null ? this.matColor[material] : material;
      return this.palette[pal & 255] || [1, 0, 1];
    }

    // Geometry for one shape and paint job. Wheels can be split out so they can spin and steer.
    geometry(shape, paint, opts = {}) {
      const pos = [], col = [], lines = [], lcol = [], wheels = [];
      const V = shape.verts.map(v => [v[0], v[1], -v[2]]);
      const lift = opts.lift || 0.35;
      // Stunts paints primitives in list order, so a polygon lying on the same plane as an earlier one
      // is a decal (road markings, start line). Only those get lifted, by how many they sit on top of;
      // everything else stays exactly where the shape puts it, so neighbouring polygons stay sealed.
      const planes = [];
      shape.prims.forEach((pr, k) => {
        const m = pr.materials[Math.min(paint, pr.materials.length - 1)] ?? 0;
        const c = this.color(m);
        if (pr.type >= 3 && pr.type <= 10) {
          const pts = pr.idx.map(i => V[i]);
          const n = normal(pts), d = n[0] * pts[0][0] + n[1] * pts[0][1] + n[2] * pts[0][2];
          let under = 0;
          for (const q of planes) if (Math.abs(q.n[0] * n[0] + q.n[1] * n[1] + q.n[2] * n[2]) > 0.999 && Math.abs(Math.abs(q.d) - Math.abs(d)) < 1.5 && overlaps(q.box, pts)) under = Math.max(under, q.level + 1);
          planes.push({ n, d, box: bbox(pts), level: under });
          const off = under * lift;
          const P = pts.map(p => [p[0] + n[0] * off, p[1] + n[1] * off, p[2] + n[2] * off]);
          for (let i = 1; i < P.length - 1; i++) {
            pos.push(...P[0], ...P[i], ...P[i + 1]);
            col.push(...c, ...c, ...c);
          }
        } else if (pr.type === 2) {
          lines.push(...V[pr.idx[0]], ...V[pr.idx[1]]); lcol.push(...c, ...c);
        } else if (pr.type === 11) {
          const a = V[pr.idx[0]], b = V[pr.idx[1]];
          sphere(pos, col, a, Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]), c);
        } else if (pr.type === 12) {
          // wheel: inner hub, inner rim-top, inner rim-front, outer hub, outer rim-top, outer rim-back
          const w = { a: V[pr.idx[0]], b: V[pr.idx[3]], r: Math.hypot(...[0, 1, 2].map(i => V[pr.idx[1]][i] - V[pr.idx[0]][i])), c, tread: this.color(pr.materials[Math.min(paint, pr.materials.length - 1)]) };
          if (opts.splitWheels) wheels.push(w); else cylinder(pos, col, w);
        }
      });
      const T = root.THREE;
      const g = new T.BufferGeometry();
      g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
      g.setAttribute('color', new T.Float32BufferAttribute(col, 3));
      g.computeVertexNormals();
      let lg = null;
      if (lines.length) {
        lg = new T.BufferGeometry();
        lg.setAttribute('position', new T.Float32BufferAttribute(lines, 3));
        lg.setAttribute('color', new T.Float32BufferAttribute(lcol, 3));
      }
      return { mesh: g, lines: lg, wheels };
    }
    cached(name, paint) {
      const key = name + ':' + paint;
      if (!this.geoCache.has(key)) this.geoCache.set(key, this.geometry(this.shapes[name], paint));
      return this.geoCache.get(key);
    }
  }

  function bbox(p) {
    const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (const v of p) for (let i = 0; i < 3; i++) { b[i] = Math.min(b[i], v[i]); b[i + 3] = Math.max(b[i + 3], v[i]); }
    return b;
  }
  function overlaps(b, p) {
    const c = bbox(p), e = 0.5;
    return c[0] < b[3] + e && c[3] > b[0] - e && c[1] < b[4] + e && c[4] > b[1] - e && c[2] < b[5] + e && c[5] > b[2] - e;
  }
  function normal(p) {
    let nx = 0, ny = 0, nz = 0;
    for (let i = 0; i < p.length; i++) {
      const a = p[i], b = p[(i + 1) % p.length];
      nx += (a[1] - b[1]) * (a[2] + b[2]); ny += (a[2] - b[2]) * (a[0] + b[0]); nz += (a[0] - b[0]) * (a[1] + b[1]);
    }
    const l = Math.hypot(nx, ny, nz) || 1;
    // prefer pointing up/outward so decals rise off the surface they sit on
    const s = ny < 0 ? -1 : 1;
    return [s * nx / l, s * ny / l, s * nz / l];
  }
  function sphere(pos, col, c, r, rgb) {
    const N = 6, M = 8;
    const pt = (i, j) => { const t = Math.PI * i / N, f = 2 * Math.PI * j / M; return [c[0] + r * Math.sin(t) * Math.cos(f), c[1] + r * Math.cos(t), c[2] + r * Math.sin(t) * Math.sin(f)]; };
    for (let i = 0; i < N; i++) for (let j = 0; j < M; j++) {
      const a = pt(i, j), b = pt(i + 1, j), d = pt(i + 1, j + 1), e = pt(i, j + 1);
      pos.push(...a, ...b, ...d, ...a, ...d, ...e); for (let k = 0; k < 6; k++) col.push(...rgb);
    }
  }
  function cylinder(pos, col, w) {
    const T = root.THREE, a = new T.Vector3(...w.a), b = new T.Vector3(...w.b);
    const ax = b.clone().sub(a).normalize();
    const u = Math.abs(ax.y) < 0.9 ? new T.Vector3(0, 1, 0) : new T.Vector3(1, 0, 0);
    const v1 = u.clone().cross(ax).normalize(), v2 = ax.clone().cross(v1).normalize();
    const S = 10, ring = (o, i) => { const t = 2 * Math.PI * i / S; return o.clone().addScaledVector(v1, Math.cos(t) * w.r).addScaledVector(v2, Math.sin(t) * w.r).toArray(); };
    const hub = w.c.map(x => x * 0.55);
    for (let i = 0; i < S; i++) {
      const p0 = ring(a, i), p1 = ring(a, i + 1), q0 = ring(b, i), q1 = ring(b, i + 1);
      pos.push(...p0, ...q0, ...q1, ...p0, ...q1, ...p1); for (let k = 0; k < 6; k++) col.push(...w.c);
      pos.push(...a.toArray(), ...p1, ...p0, ...b.toArray(), ...q0, ...q1); for (let k = 0; k < 6; k++) col.push(...hub);
    }
  }

  root.StuntsAssets = StuntsAssets;
})(window);
