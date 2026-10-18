// The game's program from your own copy of Stunts, read in the browser: GAME.EXE if you have one, else built the way
// the game's own loader does (EGA.CMN, MCGA.DIF and MCGA.COD unpacked with the game's own packer, then MCGA.HDR +
// EGA.CMN, MCGA.DIF applied, MCGA.COD after), then unpacked again (EXEPACK).
//   StuntsExe.fromFiles({ NAME: Uint8Array }) -> { img, relocs } (the program image and its relocated addresses), or
//   null when the files hold no program
'use strict';
(function (root) {
  const u16 = (b, o) => b[o] | b[o + 1] << 8;
  const imageSize = h => { const last = u16(h, 2), pages = u16(h, 4); return pages * 512 - (last ? 512 - last : 0); };

  // the game's packer (file_decomp in the original, seg012): a type byte (1 RLE, 2 VLE) and a 24-bit unpacked length;
  // a first byte with bit 7 set counts passes, each pass's output the next one's input
  function unpackFile(b) {
    let n = 1, at = 0;
    if (b[0] & 0x80) { n = b[0] & 0x7F; at = 4; }
    for (let k = 0; k < n; k++) { b = b[at] === 1 ? rle(b.subarray(at)) : b[at] === 2 ? vle(b.subarray(at)) : null; at = 0; if (!b) return null; }
    return b;
  }
  const packed = b => b && (b[0] === 1 || b[0] === 2 || ((b[0] & 0x80) && (b[4] === 1 || b[4] === 2)));
  // VLE: canonical Huffman codes, read from the top bit; byte 4: the longest code (bit 7: each byte is added to the one
  // before), then how many codes of each length, then the symbols in code order
  function vle(src) {
    const len = src[1] | src[2] << 8 | src[3] << 16, levels = src[4] & 0x7F, delta = src[4] & 0x80, out = new Uint8Array(len);
    const first = [], end = [], base = [];
    let p = 5 + levels, code = 0, sym = 0;
    for (let L = 1; L <= levels; L++) { const c = src[4 + L]; code <<= 1; first[L] = code; base[L] = sym; code += c; end[L] = code; sym += c; }
    const syms = src.subarray(p, p + sym); p += sym;
    let bit = 0, prev = 0;
    for (let o = 0; o < len; o++) {
      let c = 0, L = 0, v;
      for (;;) {
        c = c << 1 | (src[p + (bit >> 3)] >> (7 - (bit & 7)) & 1); bit++; L++;
        if (L > levels) return null;
        if (c < end[L]) { v = syms[base[L] + c - first[L]]; break; }
      }
      out[o] = prev = delta ? (v + prev) & 0xFF : v;
    }
    return out;
  }
  // RLE: escape bytes (byte 8: how many; bit 7: no sequence pass), first a pass repeating sequences (between two of the
  // second escape byte, then a count), then one repeating single bytes (escape i: i-1 copies; 1: a count byte; 3: a
  // count word)
  function rle(src) {
    const len = src[1] | src[2] << 8 | src[3] << 16, inLen = (src[4] | src[5] << 8 | src[6] << 16 | src[7] << 24) >>> 0;
    const esc = src[8], ne = esc & 0x7F, codes = src.subarray(9, 9 + ne);
    let data = src.subarray(9 + ne), count = inLen;
    if (esc <= 0x80 && esc !== 1) {
      const e = codes[1], o = [];
      let i = 0;
      while (count > 0) {
        const b = data[i++];
        if (b !== e) { o.push(b); count--; continue; }
        const start = o.length;
        for (;;) { const x = data[i++]; if (x === e) break; o.push(x); count--; }
        const reps = data[i++], seq = o.slice(start);
        for (let r = 1; r < reps; r++) for (const x of seq) o.push(x);
        count -= 3;
      }
      data = Uint8Array.from(o); count = data.length;
    }
    const tab = new Uint8Array(256);
    for (let k = 0; k < ne; k++) tab[codes[k]] = k + 1;
    const out = new Uint8Array(len);
    let i = 0, d = 0;
    while (count > 0 && d < len) {
      const b = data[i++], c = tab[b];
      if (!c) { out[d++] = b; count--; }
      else if (c === 1) { let n = data[i++]; const v = data[i++]; while (n--) out[d++] = v; count -= 3; }
      else if (c === 3) { let n = data[i] | data[i + 1] << 8; i += 2; const v = data[i++]; while (n--) out[d++] = v; count -= 4; }
      else { let n = c - 1; const v = data[i++]; while (n--) out[d++] = v; count -= 2; }
    }
    return out;
  }

  // the loader's combine step (Restunts src/execombiner): the header, the common part with the differences for the
  // MCGA (VGA) build written over it, then the MCGA code
  function combine(hdr, cmn, dif, cod) {
    const exe = new Uint8Array(imageSize(hdr)), hs = u16(hdr, 8) * 16;
    exe.set(hdr.subarray(0, 30)); exe.set(cmn.subarray(0, exe.length - hs), hs);
    const body = exe.subarray(hs);
    // each record: a word (bit 15: four bytes, else two; the rest: how far on from the last), then the bytes
    let pos = -1, i = 0;
    for (;;) {
      const w = u16(dif, i); i += 2;
      if (!w) break;
      pos = (pos + (w & 0x7FFF)) & 0xFFFFF;
      const n = w & 0x8000 ? 4 : 2;
      for (let k = 0; k < n; k++) body[pos + k] = dif[i + k];
      i += n;
    }
    if (hs + cmn.length < exe.length) exe.set(cod.subarray(0, exe.length - hs - cmn.length), hs + cmn.length);
    return exe;
  }

  // an MZ program as loaded: the image and the relocations
  function load(exe) {
    const hs = u16(exe, 8) * 16, img = exe.slice(hs, imageSize(exe)), relocs = [];
    for (let i = 0, n = u16(exe, 6), o = u16(exe, 0x18); i < n; i++, o += 4) relocs.push(u16(exe, o + 2) * 16 + u16(exe, o));
    const cs = u16(exe, 0x16), ip = u16(exe, 0x14), h = cs * 16;
    // EXEPACK: a small unpacker at CS:0 with its header (ip, cs, mem, size, sp, ss, length, [skip,] "RB")
    const sig = [16, 14].find(k => img[h + k] === 0x52 && img[h + k + 1] === 0x42);
    if (ip !== 0x10 && ip !== 0x12 || sig == null) return { img, relocs };
    return unpack(img, h, sig);
  }
  function unpack(img, h, sig) {
    const destLen = u16(img, h + 12) * 16, skip = sig === 16 ? u16(img, h + 14) : 1, size = u16(img, h + 6);
    const buf = new Uint8Array(Math.max(destLen, h));
    let src = h - (skip - 1) * 16, dst = destLen;
    buf.set(img.subarray(0, src));
    for (let k = 0; k < 16 && buf[src - 1] === 0xFF; k++) src--;
    let cmd;
    do {
      cmd = buf[--src]; let len = buf[--src] << 8; len |= buf[--src];
      if ((cmd & 0xFE) === 0xB0) { const v = buf[--src]; while (len--) buf[--dst] = v; }
      else if ((cmd & 0xFE) === 0xB2) { while (len--) buf[--dst] = buf[--src]; }
      else throw new Error('This GAME.EXE is not one Stunts can use (its packing is damaged).');
    } while (!(cmd & 1));
    // the relocations follow the unpacker's message: for each 64 KB of the program, a count then the offsets
    const block = img.subarray(h, h + size), msg = 'Packed file is corrupt';
    let at = -1;
    for (let i = 0; i + msg.length <= block.length && at < 0; i++) { let k = 0; while (k < msg.length && block[i + k] === msg.charCodeAt(k)) k++; if (k === msg.length) at = i + k; }
    if (at < 0) throw new Error('This GAME.EXE is not one Stunts can use.');
    const relocs = [];
    for (let seg = 0; seg < 16; seg++) { const n = u16(block, at); at += 2; for (let i = 0; i < n; i++, at += 2) relocs.push(seg * 0x10000 + u16(block, at)); }
    return { img: buf.subarray(0, destLen), relocs };
  }

  function fromFiles(files) {
    let p = null;
    if (files['GAME.EXE']) p = load(files['GAME.EXE']);
    else if (files['MCGA.HDR'] && files['EGA.CMN'] && files['MCGA.DIF'] && files['MCGA.COD']) {
      const part = n => packed(files[n]) ? unpackFile(files[n]) : files[n], cmn = part('EGA.CMN'), dif = part('MCGA.DIF'), cod = part('MCGA.COD');
      if (!cmn || !dif || !cod) return null;
      p = load(combine(part('MCGA.HDR'), cmn, dif, cod));   // (Stunts 1.0's header is packed too)
    }
    if (!p) return null;
    // the copy-protection question off, as in the copy the Restunts project works from (mov byte ptr [0A6AAh], 1)
    const c = p.img;
    if (c[0x2A8] === 0xC6 && c[0x2A9] === 0x06 && c[0x2AA] === 0xAA && c[0x2AB] === 0xA6 && c[0x2AC] === 0) { p.img = c.slice(); p.img[0x2AC] = 1; }
    return p;
  }
  root.StuntsExe = { fromFiles, combine, load, unpackFile };
  if (typeof module !== 'undefined') module.exports = root.StuntsExe;
})(typeof self !== 'undefined' ? self : globalThis);
