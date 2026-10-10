// A decoder for the 16-bit x86 (8086/80286) code the game is made of: one instruction at a time, as TASM-style text
// (the form tools/asm2js.py reads), so the game's code can be translated in the browser from the player's own
// GAME.EXE.  decode(bytes, offset) -> { len, op, args: [text], size, rel (jump/call target offset), raw }
'use strict';
(function (root) {
  const R16 = ['ax', 'cx', 'dx', 'bx', 'sp', 'bp', 'si', 'di'], R8 = ['al', 'cl', 'dl', 'bl', 'ah', 'ch', 'dh', 'bh'], SR = ['es', 'cs', 'ss', 'ds'];
  const EA = ['bx+si', 'bx+di', 'bp+si', 'bp+di', 'si', 'di', 'bp', 'bx'];
  const ALU = ['add', 'or', 'adc', 'sbb', 'and', 'sub', 'xor', 'cmp'], SHF = ['rol', 'ror', 'rcl', 'rcr', 'shl', 'shr', 'sal', 'sar'];
  const JCC = ['jo', 'jno', 'jb', 'jnb', 'jz', 'jnz', 'jbe', 'ja', 'js', 'jns', 'jp', 'jnp', 'jl', 'jge', 'jle', 'jg'];
  const hex = (v, w) => { v &= w === 1 ? 0xFF : 0xFFFF; const h = v.toString(16).toUpperCase(); return (/^[A-F]/.test(h) ? '0' : '') + h + 'h'; };
  const s8 = v => (v << 24) >> 24, s16 = v => (v << 16) >> 16;

  function decode(b, at) {
    let p = at, seg = null, rep = null;
    const u8 = () => b[p++], u16 = () => { const v = b[p] | (b[p + 1] << 8); p += 2; return v; };
    // prefixes
    for (;;) {
      const x = b[p];
      if (x === 0x26 || x === 0x2E || x === 0x36 || x === 0x3E) { seg = SR[(x >> 3) & 3]; p++; }
      else if (x === 0xF2 || x === 0xF3) { rep = x; p++; }
      else if (x === 0xF0) p++;
      else break;
    }
    const o = u8();
    let modrm = null;
    const rm = (w, sizeHint) => {   // the r/m operand (w: 1 byte, 2 word, 4 dword pointer)
      if (modrm === null) modrm = u8();
      const mod = modrm >> 6, r = modrm & 7;
      if (mod === 3) return { reg: true, text: w === 1 ? R8[r] : R16[r] };
      let base = EA[r], disp = 0;
      if (mod === 0 && r === 6) { base = null; disp = u16(); }
      else if (mod === 1) disp = s8(u8());
      else if (mod === 2) disp = s16(u16());
      const sz = sizeHint === false ? '' : (w === 1 ? 'byte ptr ' : w === 4 ? 'dword ptr ' : 'word ptr ');
      const pre = seg ? seg + ':' : '';
      const inner = base ? base + (disp ? (disp > 0 ? '+' : '-') + hex(Math.abs(disp), 2) : '') : hex(disp, 2);
      return { mem: true, base, disp, text: sz + pre + '[' + inner + ']' };
    };
    const reg = w => { if (modrm === null) modrm = u8(); const r = (modrm >> 3) & 7; return w === 1 ? R8[r] : R16[r]; };
    const out = (op, args, extra) => Object.assign({ len: p - at, op: (rep ? (rep === 0xF2 ? 'repne ' : (/^(cmps|scas)/.test(op) ? 'repe ' : 'rep ')) : '') + op, args }, extra || {});

    if (o < 0x40 && (o & 7) < 6) {   // ALU forms
      const op = ALU[o >> 3], f = o & 7;
      if (f === 0) { const m = rm(1); return out(op, [m.text, reg(1)]); }
      if (f === 1) { const m = rm(2); return out(op, [m.text, reg(2)]); }
      if (f === 2) { const m = rm(1); return out(op, [reg(1), m.text]); }
      if (f === 3) { const m = rm(2); return out(op, [reg(2), m.text]); }
      if (f === 4) return out(op, ['al', hex(u8(), 1)]);
      return out(op, ['ax', hex(u16(), 2)]);
    }
    if (o < 0x20 && (o & 7) === 6) return out('push', [SR[o >> 3]]);
    if (o < 0x20 && (o & 7) === 7) return out('pop', [SR[o >> 3]]);
    if (o === 0x27) return out('daa', []); if (o === 0x2F) return out('das', []); if (o === 0x37) return out('aaa', []); if (o === 0x3F) return out('aas', []);
    if (o >= 0x40 && o < 0x48) return out('inc', [R16[o & 7]]);
    if (o >= 0x48 && o < 0x50) return out('dec', [R16[o & 7]]);
    if (o >= 0x50 && o < 0x58) return out('push', [R16[o & 7]]);
    if (o >= 0x58 && o < 0x60) return out('pop', [R16[o & 7]]);
    if (o === 0x60) return out('pusha', []); if (o === 0x61) return out('popa', []);
    if (o === 0x68) return out('push', [hex(u16(), 2)]);
    if (o === 0x6A) return out('push', [hex(s8(u8()), 2)]);
    if (o === 0x69 || o === 0x6B) { const m = rm(2), r = reg(2); const v = o === 0x69 ? u16() : s8(u8()); return out('imul', [r, m.text, hex(v, 2)]); }
    if (o >= 0x70 && o < 0x80) { const d = s8(u8()); return out(JCC[o & 15], [], { rel: p + d, short: true }); }
    if (o >= 0x80 && o <= 0x83) {
      const w = o & 1 ? 2 : 1, m = rm(w), op = ALU[(modrm >> 3) & 7];
      const v = o === 0x81 ? u16() : o === 0x83 ? s8(u8()) : u8();
      return out(op, [m.text, hex(v, w)], { immSigned: o === 0x83 });
    }
    if (o === 0x84 || o === 0x85) { const w = o & 1 ? 2 : 1, m = rm(w); return out('test', [m.text, reg(w)]); }
    if (o === 0x86 || o === 0x87) { const w = o & 1 ? 2 : 1, m = rm(w); return out('xchg', [reg(w), m.text]); }   // (register first, as IDA writes it)
    if (o >= 0x88 && o <= 0x8B) {
      const w = o & 1 ? 2 : 1, m = rm(w);
      return o & 2 ? out('mov', [reg(w), m.text]) : out('mov', [m.text, reg(w)]);
    }
    if (o === 0x8C) { const m = rm(2); return out('mov', [m.text, SR[(modrm >> 3) & 3]]); }
    if (o === 0x8E) { const m = rm(2); return out('mov', [SR[(modrm >> 3) & 3], m.text]); }
    if (o === 0x8D) { const m = rm(2, false); return out('lea', [reg(2), m.text]); }
    if (o === 0x8F) { const m = rm(2); return out('pop', [m.text]); }
    if (o === 0x90) return out('nop', []);
    if (o > 0x90 && o < 0x98) return out('xchg', ['ax', R16[o & 7]]);
    if (o === 0x98) return out('cbw', []); if (o === 0x99) return out('cwd', []);
    if (o === 0x9A) { const off = u16(), sg = u16(); return out('call', [], { far: [sg, off] }); }
    if (o === 0x9B) return out('wait', []); if (o === 0x9C) return out('pushf', []); if (o === 0x9D) return out('popf', []);
    if (o === 0x9E) return out('sahf', []); if (o === 0x9F) return out('lahf', []);
    if (o >= 0xA0 && o <= 0xA3) {
      const w = o & 1 ? 2 : 1, a = u16(), m = (w === 1 ? 'byte ptr ' : 'word ptr ') + (seg ? seg + ':' : '') + '[' + hex(a, 2) + ']';
      return o & 2 ? out('mov', [m, w === 1 ? 'al' : 'ax'], { abs: a }) : out('mov', [w === 1 ? 'al' : 'ax', m], { abs: a });
    }
    const STR = { 0xA4: 'movsb', 0xA5: 'movsw', 0xA6: 'cmpsb', 0xA7: 'cmpsw', 0xAA: 'stosb', 0xAB: 'stosw', 0xAC: 'lodsb', 0xAD: 'lodsw', 0xAE: 'scasb', 0xAF: 'scasw' };
    if (STR[o]) return out(STR[o], seg ? [seg] : []);
    if (o === 0xA8) return out('test', ['al', hex(u8(), 1)]);
    if (o === 0xA9) return out('test', ['ax', hex(u16(), 2)]);
    if (o >= 0xB0 && o < 0xB8) return out('mov', [R8[o & 7], hex(u8(), 1)]);
    if (o >= 0xB8 && o < 0xC0) return out('mov', [R16[o & 7], hex(u16(), 2)]);
    if (o === 0xC0 || o === 0xC1 || (o >= 0xD0 && o <= 0xD3)) {
      const w = o & 1 ? 2 : 1, m = rm(w), op = SHF[(modrm >> 3) & 7];
      const n = o <= 0xC1 ? hex(u8(), 1) : o >= 0xD2 ? 'cl' : '1';
      return out(op, [m.text, n]);
    }
    if (o === 0xC2) return out('retn', [hex(u16(), 2)]);
    if (o === 0xC3) return out('retn', []);
    if (o === 0xC4) { const m = rm(4); return out('les', [reg(2), m.text]); }
    if (o === 0xC5) { const m = rm(4); return out('lds', [reg(2), m.text]); }
    if (o === 0xC6 || o === 0xC7) { const w = o & 1 ? 2 : 1, m = rm(w); return out('mov', [m.text, hex(w === 1 ? u8() : u16(), w)]); }
    if (o === 0xC8) { const a = u16(), l = u8(); return out('enter', [hex(a, 2), hex(l, 1)]); }
    if (o === 0xC9) return out('leave', []);
    if (o === 0xCA) return out('retf', [hex(u16(), 2)]);
    if (o === 0xCB) return out('retf', []);
    if (o === 0xCC) return out('int', ['3']);
    if (o === 0xCD) return out('int', [hex(u8(), 1)]);
    if (o === 0xCF) return out('iret', []);
    if (o === 0xD7) return out('xlat', []);
    if (o >= 0xD8 && o <= 0xDF) { rm(2); return out('esc', [], { fpu: true }); }
    if (o === 0xE0) { const d = s8(u8()); return out('loopne', [], { rel: p + d }); }
    if (o === 0xE1) { const d = s8(u8()); return out('loope', [], { rel: p + d }); }
    if (o === 0xE2) { const d = s8(u8()); return out('loop', [], { rel: p + d }); }
    if (o === 0xE3) { const d = s8(u8()); return out('jcxz', [], { rel: p + d }); }
    if (o === 0xE4) return out('in', ['al', hex(u8(), 1)]); if (o === 0xE5) return out('in', ['ax', hex(u8(), 1)]);
    if (o === 0xE6) return out('out', [hex(u8(), 1), 'al']); if (o === 0xE7) return out('out', [hex(u8(), 1), 'ax']);
    if (o === 0xE8) { const d = s16(u16()); return out('call', [], { rel: p + d }); }
    if (o === 0xE9) { const d = s16(u16()); return out('jmp', [], { rel: p + d }); }
    if (o === 0xEA) { const off = u16(), sg = u16(); return out('jmp', [], { far: [sg, off] }); }
    if (o === 0xEB) { const d = s8(u8()); return out('jmp', [], { rel: p + d, short: true }); }
    if (o === 0xEC) return out('in', ['al', 'dx']); if (o === 0xED) return out('in', ['ax', 'dx']);
    if (o === 0xEE) return out('out', ['dx', 'al']); if (o === 0xEF) return out('out', ['dx', 'ax']);
    if (o === 0xF4) return out('hlt', []); if (o === 0xF5) return out('cmc', []);
    if (o === 0xF6 || o === 0xF7) {
      const w = o & 1 ? 2 : 1, m = rm(w), k = (modrm >> 3) & 7;
      if (k === 0 || k === 1) return out('test', [m.text, hex(w === 1 ? u8() : u16(), w)]);
      return out(['', '', 'not', 'neg', 'mul', 'imul', 'div', 'idiv'][k], [m.text]);
    }
    if (o === 0xF8) return out('clc', []); if (o === 0xF9) return out('stc', []); if (o === 0xFA) return out('cli', []);
    if (o === 0xFB) return out('sti', []); if (o === 0xFC) return out('cld', []); if (o === 0xFD) return out('std', []);
    if (o === 0xFE) { const m = rm(1), k = (modrm >> 3) & 7; return out(k === 0 ? 'inc' : 'dec', [m.text]); }
    if (o === 0xFF) {
      if (modrm === null) modrm = u8();
      const k = (modrm >> 3) & 7;
      if (k === 3 || k === 5) { const m = rm(4); return out(k === 3 ? 'call' : 'jmp', [m.text], { indirectFar: true }); }
      const m = rm(2);
      return out(['inc', 'dec', 'call', 'call', 'jmp', 'jmp', 'push', '?'][k], [m.text], k === 2 || k === 4 ? { indirect: true } : {});
    }
    return out('db', [hex(o, 1)], { bad: true });
  }
  root.X86Dec = { decode };
  if (typeof module !== 'undefined') module.exports = { decode };
})(typeof self !== 'undefined' ? self : globalThis);
