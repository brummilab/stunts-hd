// A small 8086 interpreter for the sound driver the game loads at run time (AD15.DRV for AdLib/Sound
// Blaster). The game far-calls the driver's entry points (a jump table at its start); the driver
// programs the OPL2 chip through ports 388h/389h. Here its code runs instruction by instruction on the
// game's registers and memory, and OPL register writes go to onWrite(register, value).
// Two routines are replaced: the I/O delay (it busy-waits on PIT channel 2) and the digitised-sample
// player (it takes over int 8 at a high rate and plays samples through an operator's volume); samples
// go to onSample instead.
'use strict';
(function (root) {
  const R16 = ['ax', 'cx', 'dx', 'bx', 'sp', 'bp', 'si', 'di'], SREG = ['es', 'cs', 'ss', 'ds'];
  const s8 = v => (v << 24) >> 24, s16 = v => (v << 16) >> 16;
  const parity = v => { v &= 0xFF; v ^= v >> 4; v ^= v >> 2; v ^= v >> 1; return !(v & 1); };

  class Drv86 {
    constructor(pc, { onWrite = () => {}, onSample = () => {} } = {}) {
      this.pc = pc; this.onWrite = onWrite; this.onSample = onSample;
      this.index = 0; this.timer = 0; this.status = 0; this.hooks = null;
    }
    // known routines of AD15.DRV, recognised by their first bytes
    patch(cs) {
      const m = this.pc.mem, at = (o, bytes) => bytes.every((b, i) => m[((cs << 4) + o + i) & 0xFFFFF] === b);
      this.hooks = {};
      if (at(0x4F6, [0x50, 0x51, 0xF7, 0xD8])) this.hooks[0x4F6] = 'delay';
      if (at(0xAEA, [0x50, 0x2E, 0x89, 0x3E, 0xD7, 0x0C])) this.hooks[0xAEA] = 'sample';
      if (at(0xBEB, [0x50, 0x57, 0x1E])) this.hooks[0xBEB] = 'unhook';
      this.hookSeg = cs;
      this.known = !!(this.hooks[0x4F6] && this.hooks[0xAEA]);   // AD15.DRV; other drivers are not run
    }

    // run the far procedure at cs:ip; returns when it executes the retf back to the caller's frame
    supports(cs) { if (this.hookSeg !== cs) this.patch(cs); return this.known; }
    run(r, cs, ip) {
      if (this.hookSeg !== cs) this.patch(cs);
      const pc = this.pc, m = pc.mem, H = this.hooks, sp0 = r.sp;
      const lin = (s, o) => ((s << 4) + (o & 0xFFFF)) & 0xFFFFF;
      const rb = (s, o) => m[lin(s, o)], rw = (s, o) => m[lin(s, o)] | (m[lin(s, o + 1)] << 8);
      const wb = (s, o, v) => { m[lin(s, o)] = v & 0xFF; };
      const ww = (s, o, v) => { m[lin(s, o)] = v & 0xFF; m[lin(s, o + 1)] = (v >> 8) & 0xFF; };
      const push = v => { r.sp = (r.sp - 2) & 0xFFFF; ww(r.ss, r.sp, v); };
      const pop = () => { const v = rw(r.ss, r.sp); r.sp = (r.sp + 2) & 0xFFFF; return v; };
      const f8 = () => { const v = m[lin(cs, ip)]; ip = (ip + 1) & 0xFFFF; return v; };
      const f16 = () => { const v = f8(); return v | (f8() << 8); };
      const g8 = i => i < 4 ? r[R16[i]] & 0xFF : r[R16[i - 4]] >> 8;
      const s8r = (i, v) => { if (i < 4) r[R16[i]] = (r[R16[i]] & 0xFF00) | (v & 0xFF); else r[R16[i - 4]] = (r[R16[i - 4]] & 0xFF) | ((v & 0xFF) << 8); };
      const flags = () => pc.flagsWord(r);
      const SV = s => s === 'cs' ? cs : r[s];
      let seg = null, rep = null, ea = null;
      // ModRM: sets ea = { reg: index } or { s, o } and returns the reg field
      const modrm = () => {
        const b = f8(), mod = b >> 6, reg = (b >> 3) & 7, rm = b & 7;
        if (mod === 3) { ea = { reg: rm }; return reg; }
        let o, s = 'ds';
        switch (rm) {
          case 0: o = r.bx + r.si; break; case 1: o = r.bx + r.di; break;
          case 2: o = r.bp + r.si; s = 'ss'; break; case 3: o = r.bp + r.di; s = 'ss'; break;
          case 4: o = r.si; break; case 5: o = r.di; break;
          case 6: if (mod === 0) o = f16(); else { o = r.bp; s = 'ss'; } break;
          case 7: o = r.bx; break;
        }
        if (mod === 1) o += s8(f8()); else if (mod === 2) o += f16();
        ea = { s: SV(seg || s), o: o & 0xFFFF };
        return reg;
      };
      const ld = w => ea.reg != null ? (w ? r[R16[ea.reg]] : g8(ea.reg)) : (w ? rw(ea.s, ea.o) : rb(ea.s, ea.o));
      const st = (w, v) => { if (ea.reg != null) { if (w) r[R16[ea.reg]] = v & 0xFFFF; else s8r(ea.reg, v); } else if (w) ww(ea.s, ea.o, v); else wb(ea.s, ea.o, v); };
      const logic = (v, w) => { r.cf = 0; r.of = false; r.zf = v === 0; r.sf = !!(v & (w ? 0x8000 : 0x80)); return v; };
      const alu = (op, a, b, w) => {
        let v;
        switch (op) {
          case 0: v = w ? pc.add16(r, a, b) : pc.add8(r, a, b); break;
          case 1: v = logic(a | b, w); break;
          case 2: v = w ? pc.adc16(r, a, b) : pc.adc8(r, a, b); break;
          case 3: v = w ? pc.sbb16(r, a, b) : pc.sbb8(r, a, b); break;
          case 4: v = logic(a & b, w); break;
          case 5: case 7: v = w ? pc.sub16(r, a, b) : pc.sub8(r, a, b); break;
          case 6: v = logic(a ^ b, w); break;
        }
        r.pf = parity(v);
        return op === 7 ? null : v;
      };
      const cond = c => {
        switch (c >> 1) {
          case 0: return (r.of ? 1 : 0) ^ (c & 1);
          case 1: return (r.cf ? 1 : 0) ^ (c & 1);
          case 2: return (r.zf ? 1 : 0) ^ (c & 1);
          case 3: return (r.cf || r.zf ? 1 : 0) ^ (c & 1);
          case 4: return (r.sf ? 1 : 0) ^ (c & 1);
          case 5: return (r.pf ? 1 : 0) ^ (c & 1);
          case 6: return (r.sf !== r.of ? 1 : 0) ^ (c & 1);
          case 7: return (r.zf || r.sf !== r.of ? 1 : 0) ^ (c & 1);
        }
      };
      const SH = ['rol', 'ror', 'rcl', 'rcr', 'shl', 'shr', 'shl', 'sar'];
      const out = (port, v) => this.out(port, v & 0xFF, cs);
      const inp = port => this.inp(port, cs);

      for (let steps = 0; ; steps++) {
        if (steps > 2e6) throw new Error('sound driver: runaway at ' + cs.toString(16) + ':' + ip.toString(16));
        if (seg === null && rep === null && H[ip]) {
          const h = H[ip];
          if (h === 'sample') this.sample(r, cs);
          ip = pop(); continue;   // all hooked routines are near procedures
        }
        const op = f8();
        switch (op) {
          case 0x26: seg = 'es'; continue; case 0x2E: seg = 'cs'; continue;
          case 0x36: seg = 'ss'; continue; case 0x3E: seg = 'ds'; continue;
          case 0xF2: rep = 'repne'; continue; case 0xF3: rep = 'rep'; continue;
        }
        if (op < 0x40 && (op & 7) < 6) {   // ALU
          const k = op >> 3, w = op & 1;
          if ((op & 7) < 4) {
            const reg = modrm(), d = op & 2;
            const a = d ? (w ? r[R16[reg]] : g8(reg)) : ld(w), b = d ? ld(w) : (w ? r[R16[reg]] : g8(reg));
            const v = alu(k, a, b, w);
            if (v !== null) { if (d) { if (w) r[R16[reg]] = v; else s8r(reg, v); } else st(w, v); }
          } else {
            const b = w ? f16() : f8(), v = alu(k, w ? r.ax : r.ax & 0xFF, b, w);
            if (v !== null) r.ax = w ? v : (r.ax & 0xFF00) | v;
          }
        } else switch (op) {
          case 0x06: push(r.es); break; case 0x07: r.es = pop(); break;
          case 0x0E: push(cs); break;
          case 0x16: push(r.ss); break; case 0x17: r.ss = pop(); break;
          case 0x1E: push(r.ds); break; case 0x1F: r.ds = pop(); break;
          case 0x40: case 0x41: case 0x42: case 0x43: case 0x44: case 0x45: case 0x46: case 0x47: { const c = r.cf; r[R16[op & 7]] = pc.inc16(r, r[R16[op & 7]]); r.cf = c; break; }
          case 0x48: case 0x49: case 0x4A: case 0x4B: case 0x4C: case 0x4D: case 0x4E: case 0x4F: { const c = r.cf; r[R16[op & 7]] = pc.dec16(r, r[R16[op & 7]]); r.cf = c; break; }
          case 0x50: case 0x51: case 0x52: case 0x53: case 0x54: case 0x55: case 0x56: case 0x57: push(op === 0x54 ? r.sp : r[R16[op & 7]]); break;
          case 0x58: case 0x59: case 0x5A: case 0x5B: case 0x5C: case 0x5D: case 0x5E: case 0x5F: r[R16[op & 7]] = pop(); break;
          case 0x70: case 0x71: case 0x72: case 0x73: case 0x74: case 0x75: case 0x76: case 0x77:
          case 0x78: case 0x79: case 0x7A: case 0x7B: case 0x7C: case 0x7D: case 0x7E: case 0x7F: { const d = s8(f8()); if (cond(op & 15)) ip = (ip + d) & 0xFFFF; break; }
          case 0x80: case 0x81: case 0x82: case 0x83: {
            const k = modrm(), w = op & 1, a = ld(w), b = op === 0x81 ? f16() : op === 0x83 ? s8(f8()) & 0xFFFF : f8();
            const v = alu(k, a, b, w); if (v !== null) st(w, v); break;
          }
          case 0x84: case 0x85: { const reg = modrm(), w = op & 1; logic(ld(w) & (w ? r[R16[reg]] : g8(reg)), w); break; }
          case 0x86: case 0x87: { const reg = modrm(), w = op & 1, a = ld(w); st(w, w ? r[R16[reg]] : g8(reg)); if (w) r[R16[reg]] = a; else s8r(reg, a); break; }
          case 0x88: case 0x89: { const reg = modrm(), w = op & 1; st(w, w ? r[R16[reg]] : g8(reg)); break; }
          case 0x8A: case 0x8B: { const reg = modrm(), w = op & 1, v = ld(w); if (w) r[R16[reg]] = v; else s8r(reg, v); break; }
          case 0x8C: { const reg = modrm(); st(1, reg === 1 ? cs : r[SREG[reg]]); break; }
          case 0x8D: { const reg = modrm(); r[R16[reg]] = ea.o; break; }
          case 0x8E: { const reg = modrm(); r[SREG[reg]] = ld(1); break; }
          case 0x8F: { modrm(); st(1, pop()); break; }
          case 0x90: break;
          case 0x91: case 0x92: case 0x93: case 0x94: case 0x95: case 0x96: case 0x97: { const t = r.ax; r.ax = r[R16[op & 7]]; r[R16[op & 7]] = t; break; }
          case 0x98: r.ax = s8(r.ax & 0xFF) & 0xFFFF; break;
          case 0x99: r.dx = r.ax & 0x8000 ? 0xFFFF : 0; break;
          case 0x9C: push(flags()); break;
          case 0x9D: pc.setFlags(r, pop()); break;
          case 0x9E: pc.setFlags(r, (flags() & 0xFF00) | (r.ax >> 8)); break;
          case 0x9F: r.ax = (r.ax & 0xFF) | ((flags() & 0xFF) << 8); break;
          case 0xA0: r.ax = (r.ax & 0xFF00) | rb(seg ? SV(seg) : r.ds, f16()); break;
          case 0xA1: r.ax = rw(seg ? SV(seg) : r.ds, f16()); break;
          case 0xA2: wb(seg ? SV(seg) : r.ds, f16(), r.ax); break;
          case 0xA3: ww(seg ? SV(seg) : r.ds, f16(), r.ax); break;
          case 0xA4: case 0xA5: case 0xA6: case 0xA7: case 0xAA: case 0xAB: case 0xAC: case 0xAD: case 0xAE: case 0xAF: {
            if (seg) throw new Error('sound driver: segment override on a string instruction');
            const name = { 0xA4: 'movsb', 0xA5: 'movsw', 0xA6: 'cmpsb', 0xA7: 'cmpsw', 0xAA: 'stosb', 0xAB: 'stosw', 0xAC: 'lodsb', 0xAD: 'lodsw', 0xAE: 'scasb', 0xAF: 'scasw' }[op];
            pc.str(r, name, rep === 'repne' ? 'repne' : rep && (op === 0xA6 || op === 0xA7 || op === 0xAE || op === 0xAF) ? 'repe' : rep);
            break;
          }
          case 0xA8: logic(r.ax & 0xFF & f8(), 0); break;
          case 0xA9: logic(r.ax & f16(), 1); break;
          case 0xB0: case 0xB1: case 0xB2: case 0xB3: case 0xB4: case 0xB5: case 0xB6: case 0xB7: s8r(op & 7, f8()); break;
          case 0xB8: case 0xB9: case 0xBA: case 0xBB: case 0xBC: case 0xBD: case 0xBE: case 0xBF: r[R16[op & 7]] = f16(); break;
          case 0xC2: { const n = f16(); ip = pop(); r.sp = (r.sp + n) & 0xFFFF; break; }
          case 0xC3: ip = pop(); break;
          case 0xC4: case 0xC5: { const reg = modrm(); r[R16[reg]] = rw(ea.s, ea.o); r[op === 0xC4 ? 'es' : 'ds'] = rw(ea.s, ea.o + 2); break; }
          case 0xC6: { modrm(); st(0, f8()); break; }
          case 0xC7: { modrm(); st(1, f16()); break; }
          case 0xCA: case 0xCB: {
            const n = op === 0xCA ? f16() : 0;
            if (r.sp === sp0) { r.sp = (r.sp + n) & 0xFFFF; return; }   // back to the game (callfar pops the frame)
            throw new Error('sound driver: unexpected far return at ' + cs.toString(16) + ':' + ip.toString(16));
          }
          case 0xD0: case 0xD1: case 0xD2: case 0xD3: {
            const k = modrm(), w = op & 1, n = op & 2 ? r.cx & 0x1F : 1, v = pc.sh(r, ld(w), n, w ? 16 : 8, SH[k]);
            if (n && k >= 4) r.pf = parity(v);
            st(w, v); break;
          }
          case 0xE0: case 0xE1: case 0xE2: {
            const d = s8(f8()); r.cx = (r.cx - 1) & 0xFFFF;
            if (r.cx && (op === 0xE2 || (op === 0xE1) === !!r.zf)) ip = (ip + d) & 0xFFFF;
            break;
          }
          case 0xE3: { const d = s8(f8()); if (!r.cx) ip = (ip + d) & 0xFFFF; break; }
          case 0xE4: r.ax = (r.ax & 0xFF00) | inp(f8()); break;
          case 0xE6: out(f8(), r.ax); break;
          case 0xEC: r.ax = (r.ax & 0xFF00) | inp(r.dx); break;
          case 0xEE: out(r.dx, r.ax); break;
          case 0xE8: { const d = f16(); push(ip); ip = (ip + d) & 0xFFFF; break; }
          case 0xE9: { const d = f16(); ip = (ip + d) & 0xFFFF; break; }
          case 0xEB: { const d = s8(f8()); ip = (ip + d) & 0xFFFF; break; }
          case 0xF5: r.cf = r.cf ? 0 : 1; break;
          case 0xF6: case 0xF7: {
            const k = modrm(), w = op & 1, a = ld(w);
            switch (k) {
              case 0: case 1: logic(a & (w ? f16() : f8()), w); break;
              case 2: st(w, ~a); break;
              case 3: st(w, w ? pc.neg16(r, a) : pc.neg8(r, a)); break;
              case 4: if (w) pc.mul16(r, a); else pc.mul8(r, a); break;
              case 5: if (w) pc.imul16(r, a); else pc.imul8(r, a); break;
              case 6: if (w) pc.div16(r, a); else pc.div8(r, a); break;
              case 7: if (w) pc.idiv16(r, a); else pc.idiv8(r, a); break;
            }
            break;
          }
          case 0xF8: r.cf = 0; break; case 0xF9: r.cf = 1; break;
          case 0xFA: case 0xFB: break;   // cli/sti: nothing interrupts the driver here
          case 0xFC: r.df = 0; break; case 0xFD: r.df = 1; break;
          case 0xFE: { const k = modrm(), c = r.cf; st(0, k ? pc.dec8(r, ld(0)) : pc.inc8(r, ld(0))); r.cf = c; break; }
          case 0xFF: {
            const k = modrm();
            switch (k) {
              case 0: case 1: { const c = r.cf; st(1, k ? pc.dec16(r, ld(1)) : pc.inc16(r, ld(1))); r.cf = c; break; }
              case 2: { const t = ld(1); push(ip); ip = t; break; }
              case 4: ip = ld(1); break;
              case 6: push(ld(1)); break;
              default: throw new Error('sound driver: far call/jump through memory at ' + cs.toString(16) + ':' + ip.toString(16));
            }
            break;
          }
          default: throw new Error('sound driver: opcode ' + op.toString(16) + ' at ' + cs.toString(16) + ':' + ((ip - 1) & 0xFFFF).toString(16));
        }
        seg = null; rep = null;
      }
    }

    // the OPL2 at its base port (388h): index, data, and a status register whose timers expire at once
    // (enough for the driver's detection)
    out(port, v, cs) {
      const base = this.base(cs);
      if (port === base) { this.index = v; return; }
      if (port === base + 1) {
        if (this.index === 4) { if (v & 0x80) this.status = 0; else if (v & 3) this.status = 0x80 | (v & 1 ? 0x40 : 0) | (v & 2 ? 0x20 : 0); }
        this.onWrite(this.index, v);
      }
      // PIT and PIC writes belong to the replaced sample player: not passed on
    }
    inp(port, cs) { return port === this.base(cs) ? this.status : 0xFF; }
    base(cs) { return this.pc.rw(cs, 0x972) || 0x388; }

    // the sample player's arguments: es:di samples, dx:ax count, cx rate (Hz), bx plays (0: loop)
    sample(r, cs) {
      const n = r.ax, rate = r.cx, plays = r.bx, start = ((r.es << 4) + r.di) & 0xFFFFF;
      const tab = new Uint8Array(256);
      for (let i = 0; i < 256; i++) tab[i] = this.pc.mem[((cs << 4) + 0xCF3 + i) & 0xFFFFF];
      this.onSample({ data: this.pc.mem.slice(start, start + n), rate, plays, tab });
    }
  }
  root.StuntsDrv86 = Drv86;
})(typeof window !== 'undefined' ? window : globalThis);
