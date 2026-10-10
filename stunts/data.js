// Loaders for original Stunts 1.1 data files, ported from Restunts:
//   decompression  <- src/restunts/c/fileio.c (file_decomp, file_decomp_rle*, file_decomp_vle)
//   resource files <- src/resfile/resfile.cpp
//   3D shapes      <- src/resfile/shape.cpp, shape.h
//   car specs      <- src/resfile/carinfo.h
//   tracks         <- docs/format.html (1802-byte .TRK)
'use strict';
(function (root) {
  const u16 = (b, o) => b[o] | (b[o + 1] << 8);
  const s16 = (b, o) => (u16(b, o) << 16) >> 16;
  const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

  // --- fileio.c: run-length passes ---
  function rleSeq(src, srclen, esc) {
    const out = []; let i = 0;
    while (i < srclen) {
      const cur = src[i++];
      if (cur === esc) {
        const seqstart = i;
        let c;
        while ((c = src[i++]) !== esc) out.push(c);
        let rep = src[i++] - 1;
        const seqend = i;
        while (rep-- > 0) for (let k = seqstart; k < seqend - 2; k++) out.push(src[k]);
        i = seqend;
      } else out.push(cur);
    }
    return Uint8Array.from(out);
  }
  function rleSingle(src, pos, len, esclookup) {
    const dst = new Uint8Array(len); let d = 0, i = pos;
    while (d < len) {
      let cur = src[i++];
      const e = esclookup[cur];
      if (e) {
        let rep;
        if (e === 1) { rep = src[i++]; cur = src[i++]; }
        else if (e === 3) { rep = src[i] | (src[i + 1] << 8); i += 2; cur = src[i++]; }
        else { rep = e - 1; cur = src[i++]; }
        while (rep-- > 0 && d < len) dst[d++] = cur;
      } else dst[d++] = cur;
    }
    return dst;
  }
  function decompRLE(src) {
    const len = src[1] | (src[2] << 8) | (src[3] << 16);
    const h = 4;
    const srclen = src[h] | (src[h + 1] << 8) | (src[h + 2] << 16);
    let esclen = src[h + 4];
    const skipseq = (esclen & 0x80) === 0x80; esclen &= 0x7F;
    const esc = src.subarray(h + 5, h + 5 + esclen);
    const lookup = new Uint8Array(256);
    for (let i = 0; i < esclen; i++) lookup[esc[i]] = i + 1;
    let data = src, pos = h + 5 + esclen;
    if (!skipseq) { data = rleSeq(src.subarray(pos), srclen, esc[1]); pos = 0; }
    return rleSingle(data, pos, len, lookup);
  }
  // --- fileio.c: variable-length (Huffman-like) pass ---
  function decompVLE(src) {
    const len = src[1] | (src[2] << 8) | (src[3] << 16);
    let lenleft = len, p = 4;
    let esclen = src[p++];
    const additive = (esclen & 0x80) === 0x80; esclen &= 0x7F;
    const wdtpos = p;
    const esc1 = new Uint16Array(16), esc2 = new Uint16Array(16);
    let alphlen = 0;
    for (let i = 0, j = 0; i < esclen; ++i, j *= 2) {
      esc1[i] = alphlen - j;
      const tmp = src[p++]; j += tmp; alphlen += tmp; esc2[i] = j;
    }
    const alph = new Uint8Array(256);
    for (let i = 0; i < alphlen; i++) alph[i] = src[p++];
    const codpos = p; p = wdtpos;
    const symb = new Uint8Array(256), wdth = new Uint8Array(256);
    let i = 0, j = 0, numsymb = 0x80;
    const widthdistr = esclen >= 8 ? 8 : esclen;
    for (let width = 1; width <= widthdistr; ++width, numsymb >>= 1) {
      for (let sw = src[p++]; sw > 0; --sw, ++j) for (let n = numsymb; n; --n, ++i) { symb[i] = alph[j]; wdth[i] = width; }
    }
    for (; i < 256; i++) wdth[i] = 0x40;
    p = codpos;
    const dst = new Uint8Array(len); let d = 0;
    let curword = ((src[p] << 8) | src[p + 1]) & 0xFFFF; p += 2;
    let curwdt = 8, cursymb = 0, code, nextwdt;
    ++lenleft;
    while (lenleft) {
      code = curword >> 8;
      nextwdt = wdth[code];
      if (nextwdt > 8) {
        code = curword & 0xFF;
        curword >>= 8;
        let k = 7;
        for (;;) {
          if (!curwdt) { code = src[p++]; curwdt = 8; }
          curword = ((curword << 1) + ((code & 0x80) ? 1 : 0)) & 0xFFFF;
          code = (code << 1) & 0xFF;
          --curwdt; ++k;
          if (curword < esc2[k]) {
            curword = (curword + esc1[k]) & 0xFFFF;
            cursymb = additive ? (cursymb + alph[curword]) & 0xFF : alph[curword];
            if (d < len) dst[d++] = cursymb;
            --lenleft;
            break;
          }
        }
        curword = ((code << curwdt) | src[p++]) & 0xFFFF;
        nextwdt = 8 - curwdt;
        curwdt = 8;
      } else {
        cursymb = additive ? (cursymb + symb[code]) & 0xFF : symb[code];
        if (d < len) dst[d++] = cursymb;
        --lenleft;
        if (curwdt < nextwdt) {
          curword = (curword << curwdt) & 0xFFFF;
          nextwdt -= curwdt; curwdt = 8;
          curword |= src[p++];
        }
      }
      curword = (curword << nextwdt) & 0xFFFF;
      curwdt -= nextwdt;
    }
    return dst;
  }
  // file_decomp: one or more compression passes
  function decompress(buf) {
    let src = buf, passes = src[0];
    if (passes & 0x80) { passes &= 0x7F; src = src.subarray(4); } else passes = 1;
    while (passes--) {
      const type = src[0];
      if (type === 1) src = decompRLE(src);
      else if (type === 2) src = decompVLE(src);
      else throw new Error('Unknown compression type ' + type);
    }
    return src;
  }

  // --- resfile.cpp ---
  function parseRes(buf) {
    const size = u32(buf, 0), n = u16(buf, 4), dataOfs = 6 + n * 8, res = {};
    const ids = [], ofs = [];
    for (let i = 0; i < n; i++) ids.push(String.fromCharCode(...buf.subarray(6 + i * 4, 10 + i * 4)).replace(/\0+$/, ''));
    for (let i = 0; i < n; i++) ofs.push(u32(buf, 6 + n * 4 + i * 4));
    const sorted = [...ofs].sort((a, b) => a - b);
    ids.forEach((id, i) => {
      const next = sorted.find(o => o > ofs[i]);
      const end = next == null ? size - dataOfs : next;
      res[id] = buf.subarray(dataOfs + ofs[i], dataOfs + end);
    });
    return res;
  }

  // --- shape.cpp / shape.h ---
  const vertCount = t => (t < 1 || t > 12) ? 0 : t === 11 ? 2 : t === 12 ? 6 : t;
  function parseShape(b) {
    const nv = b[0], np = b[1], npaint = b[2];
    let o = 4;
    const verts = [];
    for (let i = 0; i < nv; i++, o += 6) verts.push([s16(b, o), s16(b, o + 2), s16(b, o + 4)]);
    o += np * 8; // cull1 + cull2
    const prims = [];
    for (let i = 0; i < np; i++) {
      const type = b[o], flags = b[o + 1]; o += 2;
      const materials = Array.from(b.subarray(o, o + npaint)); o += npaint;
      const n = vertCount(type);
      const idx = Array.from(b.subarray(o, o + n)); o += n;
      prims.push({ type, flags, materials, idx });
    }
    return { verts, prims, numPaints: npaint };
  }

  // --- carinfo.h (simd) ---
  function parseCar(b) {
    let o = 0;
    const c = { numGears: b[0], mass: u16(b, 2), braking: u16(b, 4), idleRpm: u16(b, 6), downshiftRpm: u16(b, 8), upshiftRpm: u16(b, 10), maxRpm: u16(b, 12) };
    o = 14;
    c.gearRatio = []; for (let i = 0; i < 7; i++, o += 2) c.gearRatio.push(u16(b, o));
    o += 7 * 4; // knobs
    c.aeroResistance = u16(b, o); o += 2;
    c.torque = Array.from(b.subarray(o, o + 104)); o += 104;
    o += 2;
    c.grip = u16(b, o); o += 2;
    o += 14;
    c.surfaceGrip = []; for (let i = 0; i < 5; i++, o += 2) c.surfaceGrip.push(u16(b, o));
    o += 10;
    c.collide = []; for (let i = 0; i < 4; i++, o += 2) c.collide.push(s16(b, o));
    c.height = s16(b, o); o += 2;
    c.wheels = []; for (let i = 0; i < 4; i++, o += 6) c.wheels.push([s16(b, o), s16(b, o + 2), s16(b, o + 4)]);
    o += 62; // steering dots
    const pts = n => { const a = []; for (let i = 0; i < n; i++) a.push([b[o + i * 2], b[o + i * 2 + 1]]); return a; };
    c.spd = { cx: u16(b, o), cy: u16(b, o + 2), n: u16(b, o + 4) }; o += 6; c.spd.pts = pts(104); o += 208;
    c.rev = { cx: u16(b, o), cy: u16(b, o + 2), n: u16(b, o + 4) }; o += 6; c.rev.pts = pts(128); o += 256;
    return c;
  }

  // --- docs/format.html: 30x30 items, horizon byte, 30x30 terrain ---
  function parseTrack(b) {
    const items = [], terrain = [];
    for (let row = 0; row < 30; row++) items.push(Array.from(b.subarray(row * 30, row * 30 + 30)));
    const horizon = b[900];
    for (let row = 0; row < 30; row++) terrain.push(Array.from(b.subarray(901 + row * 30, 901 + row * 30 + 30)));
    return { items, horizon, terrain };
  }

  // Strings in resource files: null-terminated
  function cstr(b) { let s = ''; for (const c of b) { if (!c) break; s += String.fromCharCode(c); } return s; }

  // 2D shape (sprite) from a PVS/PES resource: 16-byte header then 8-bit pixels, colour 0 transparent.
  // Unflip types 1 and 2 follow shape2d.c file_unflip_shape2d.
  function parseShape2D(b) {
    const w = u16(b, 0), h = u16(b, 2), x = s16(b, 8), y = s16(b, 10), f5 = b[14], f6 = b[15];
    let px = b.subarray(16, 16 + w * h);
    const flip = (f6 & 0xF0) === 0 ? f5 >> 4 : 0;
    if (flip === 1) { const o = new Uint8Array(w * h); for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) o[i + j * w] = px[j + i * h]; px = o; }
    else if (flip === 2) {
      const o = new Uint8Array(w * h);
      for (let j = 0; j < h; j += 2) for (let i = 0; i < w; i++) o[i + j * w] = px[(j >> 1) + i * h];
      for (let j = 0; j + 1 < h; j += 2) for (let i = 0; i < w; i++) o[w + i + j * w] = px[((h + j + 1) >> 1) + i * h];
      px = o;
    }
    return { w, h, x, y, px };
  }

  root.StuntsData = { decompress, parseRes, parseShape, parseCar, parseTrack, parseShape2D, cstr, u16, s16 };
})(typeof window !== 'undefined' ? window : globalThis);
