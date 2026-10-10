// OPL2 (YM3812) FM synthesis in an AudioWorklet, fed with the register writes the game's AdLib driver
// makes in the worker. Shared buffer layout (see index.html):
//   Int32 [0]: write count; bytes 8..263: the chip's registers as last written;
//   Float64 from byte 512: a ring of RING (time, register << 8 | value), time in ms since the epoch.
//
// The chip as it works inside, in integers, at its own rate (49716 Hz, resampled to the output's):
//  - phase: a 19-bit counter per operator, advanced by (F-number << block) times the multiple; its top 10
//    bits pick the point of the wave
//  - waves: the chip looks up -log2 of a quarter sine (256 entries) and turns level + attenuation back into
//    a linear value through a 256-entry power-of-two table, shifted by whole octaves; both tables are
//    computed here from their formulas
//  - envelopes: 9 bits (0.1875 dB a step), stepped at the chip's rates (rate 4 * R + key scaling: one step
//    every 2^(13 - rate / 4) samples, faster in quarters); the attack moves by an eighth of what is left
//  - total level, key scale level, tremolo (a triangle every 13 ms or so, 4.8 or 1 dB) and vibrato (eight
//    steps, 1024 samples each, of the F-number's top bits)
//  - feedback: the modulator's last two outputs, shifted by 9 - FB, added to its own phase
//  - percussion: the 23-bit noise generator and the phase bits of channels 7 and 8 combined as the chip
//    does for the hi-hat, snare and cymbal; the bass drum is channel 6's two operators; the five voices
//    sound twice as loud as a melodic channel
'use strict';
const RING = 8192, SR_OPL = 49716;
const MT = [1, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 20, 24, 24, 30, 30];   // multiple, doubled
const KSLROM = [0, 32, 40, 45, 48, 51, 53, 55, 56, 58, 59, 60, 61, 62, 63, 64], KSLSHIFT = [8, 1, 2, 0];
const LOGSIN = new Uint16Array(256), EXP = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  LOGSIN[i] = Math.round(-Math.log2(Math.sin((i + 0.5) * Math.PI / 512)) * 256);
  EXP[i] = Math.round(Math.pow(2, (255 - i) / 256) * 1024);
}
const calcExp = level => level > 0x1FFF ? 0 : (EXP[level & 0xFF] << 1) >> (level >> 8);
// one operator's output (signed, about +-4084) for a 10-bit phase and a 9-bit attenuation
function waveOut(ws, phase, env) {
  phase &= 0x3FF;
  const att = env << 3;
  switch (ws) {
    case 0: { const v = calcExp(LOGSIN[phase & 0x100 ? ~phase & 0xFF : phase & 0xFF] + att); return phase & 0x200 ? -v : v; }
    case 1: return phase & 0x200 ? 0 : calcExp(LOGSIN[phase & 0x100 ? ~phase & 0xFF : phase & 0xFF] + att);
    case 2: return calcExp(LOGSIN[phase & 0x100 ? ~phase & 0xFF : phase & 0xFF] + att);
    default: return phase & 0x100 ? 0 : calcExp(LOGSIN[phase & 0xFF] + att);
  }
}
// in races (not the original's balance, by choice): the effects channel (1: skids, crash) louder, and the
// landing thump (8) two octaves up (from ~24 Hz, below what small speakers play) and louder
const FX = { 1: { gain: 2.0, oct: 0 }, 8: { gain: 2.4, oct: 2 } };

class Op {
  constructor() {
    this.acc = 0; this.phase = 0; this.env = 511; this.stage = 4; this.out = 0; this.prev = 0; this.egAcc = 0;
    this.am = 0; this.vib = 0; this.egt = 0; this.ksr = 0; this.mult = 1; this.ksl = 0; this.tl = 63; this.ar = 0; this.dr = 0; this.sl = 0; this.rr = 0; this.ws = 0;
  }
}
class Chan { constructor() { this.fnum = 0; this.block = 0; this.on = false; this.fb = 0; this.con = 0; } }

class OPL extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ops = Array.from({ length: 18 }, () => new Op());
    this.ch = Array.from({ length: 9 }, () => new Chan());
    this.regs = new Uint8Array(256);
    this.offset = null; this.lat = 0.07; this.vol = 0.22; this.rd = 0;
    this.timer = 0; this.noise = 1; this.trem = 0; this.tremPos = 0; this.vibPos = 0;
    this.drums = 0; this.rhythm = false;
    this.chipT = 0; this.y0 = 0; this.y1 = 0; this.dc = 0;   // resampling: the chip's last two outputs
    this.port.onmessage = e => {
      const m = e.data;
      if (m.sab) {
        this.I = new Int32Array(m.sab, 0, 2); this.R = new Uint8Array(m.sab, 8, 256); this.F = new Float64Array(m.sab, 512, RING * 2);
        // start from the chip's current state, then follow new writes
        this.rd = Atomics.load(this.I, 0);
        this.write(0x01, this.R[1]);
        for (let a = 0x20; a < 0x100; a++) this.write(a, this.R[a]);
        this.write(0xBD, this.R[0xBD]);
      }
      if (m.offset != null) this.offset = m.offset;   // epoch ms - context ms
      if (m.vol != null) this.vol = m.vol;
      if (m.race != null) this.race = m.race;   // (the page: a race is on screen; effects boosted, see FX)
    };
  }
  keyOn(op) { if (op.stage === 4 || op.stage === 3) { op.stage = 0; op.acc = 0; op.egAcc = 0; if (this.rate(op, op.ar) >= 60) op.env = 0; } }
  keyOff(op) { if (op.stage < 3) op.stage = 3; }
  write(a, v) {
    this.regs[a] = v;
    const hi = a & 0xE0;
    if (hi === 0x20 || hi === 0x40 || hi === 0x60 || hi === 0x80 || hi === 0xE0) {
      const o = a & 0x1F; if ((o & 7) > 5 || o > 21) return;
      // register offsets 0-5, 8-13, 16-21 -> operator in channel order
      const grp = o >> 3, k = o & 7, chn = grp * 3 + (k % 3), car = k >= 3 ? 1 : 0;
      const op = this.ops[chn * 2 + car]; op.ch = chn;
      if (hi === 0x20) { op.am = v >> 7; op.vib = (v >> 6) & 1; op.egt = (v >> 5) & 1; op.ksr = (v >> 4) & 1; op.mult = MT[v & 15]; }
      else if (hi === 0x40) { op.ksl = v >> 6; op.tl = v & 63; }
      else if (hi === 0x60) { op.ar = v >> 4; op.dr = v & 15; }
      else if (hi === 0x80) { op.sl = v >> 4; op.rr = v & 15; }
      else op.ws = (this.regs[1] & 0x20) ? v & 3 : 0;
      return;
    }
    if (a >= 0xA0 && a <= 0xA8) { const c = this.ch[a - 0xA0]; c.fnum = (c.fnum & 0x300) | v; return; }
    if (a >= 0xB0 && a <= 0xB8) {
      const ci = a - 0xB0, c = this.ch[ci], on = !!(v & 0x20);
      c.fnum = (c.fnum & 0xFF) | ((v & 3) << 8); c.block = (v >> 2) & 7;
      for (const op of [this.ops[ci * 2], this.ops[ci * 2 + 1]]) { op.ch = ci; if (on && !c.on) this.keyOn(op); if (!on && c.on) this.keyOff(op); }
      c.on = on; return;
    }
    if (a >= 0xC0 && a <= 0xC8) { const c = this.ch[a - 0xC0]; c.fb = (v >> 1) & 7; c.con = v & 1; return; }
    // percussion mode (BDh bit 5): bits 4..0 key the bass drum (channel 6, both operators), snare (channel
    // 7's carrier), tom (channel 8's modulator), cymbal (channel 8's carrier) and hi-hat (channel 7's modulator)
    if (a === 0xBD) {
      const was = this.drums, now = v & 0x20 ? v & 0x1F : 0;
      for (const [bit, ops] of [[0x10, [12, 13]], [0x08, [15]], [0x04, [16]], [0x02, [17]], [0x01, [14]]]) {
        if ((now & bit) && !(was & bit)) for (const i of ops) { this.ops[i].ch = i >> 1; this.keyOn(this.ops[i]); }
        if (!(now & bit) && (was & bit)) for (const i of ops) this.keyOff(this.ops[i]);
      }
      this.drums = now; this.rhythm = !!(v & 0x20);
    }
  }
  // an envelope rate (0..63) with key scaling
  rate(op, r) {
    if (!r) return 0;
    const c = this.ch[op.ch || 0], ks = (c.block << 1) | ((c.fnum >> (this.regs[8] & 0x40 ? 8 : 9)) & 1);
    return Math.min(63, (r << 2) + (op.ksr ? ks : ks >> 2));
  }
  // one chip sample of an operator's envelope
  envStep(op) {
    let r;
    switch (op.stage) {
      case 0: r = this.rate(op, op.ar); break;
      case 1: r = this.rate(op, op.dr); break;
      case 2: if (op.egt) return; op.stage = 3; r = this.rate(op, op.rr); break;
      case 3: r = this.rate(op, op.rr); break;
      default: return;
    }
    if (!r) return;
    if (op.stage === 0 && r >= 60) { op.env = 0; op.stage = 1; return; }
    // steps due this sample: one every 2^(13 - rate / 4) samples, (4 + rate & 3) / 4 times as often
    op.egAcc += (4 + (r & 3)) * Math.pow(2, (r >> 2) - 15);
    let n = Math.floor(op.egAcc); if (!n) return;
    op.egAcc -= n;
    if (op.stage === 0) {
      while (n-- > 0 && op.env > 0) op.env += (~op.env) >> 3;   // (an eighth of what is left, rounded up)
      if (op.env <= 0) { op.env = 0; op.stage = 1; }
      return;
    }
    op.env = Math.min(511, op.env + n);
    if (op.stage === 1) { const sl = op.sl === 15 ? 0x1F0 : op.sl << 4; if (op.env >= sl) { op.env = sl; op.stage = 2; } }
    else if (op.env >= 511) { op.env = 511; op.stage = 4; }
  }
  // total attenuation (9 bits) with total level, key scale level and tremolo
  att(op) {
    const c = this.ch[op.ch || 0];
    let ksl = (KSLROM[c.fnum >> 6] << 2) - ((8 - c.block) << 5); if (ksl < 0) ksl = 0;
    const a = op.env + (op.tl << 2) + (ksl >> KSLSHIFT[op.ksl]) + (op.am ? this.trem : 0);
    return a > 511 ? 511 : a;
  }
  // advance an operator's phase counter; returns its 10-bit phase
  phaseStep(op, c, oct) {
    let f = c.fnum;
    if (op.vib) {   // vibrato: the F-number's top bits, in eight steps
      let range = (f >> 7) & 7, p = this.vibPos;
      if (!(p & 3)) range = 0; else if (p & 1) range >>= 1;
      if (!(this.regs[0xBD] & 0x40)) range >>= 1;
      f += p & 4 ? -range : range;
    }
    const block = Math.min(7, c.block + oct);
    op.acc = (op.acc + ((((f << block) >> 1) * op.mult) >> 1)) & 0x7FFFF;
    return op.acc >> 9;
  }
  // one sample of the chip: the mixed output
  chipSample() {
    // tremolo: a triangle 0..105 over 210 steps of 64 samples; vibrato: eight steps of 1024 samples
    this.timer++;
    if ((this.timer & 63) === 0) { this.tremPos = (this.tremPos + 1) % 210; }
    this.trem = (this.tremPos < 105 ? this.tremPos : 210 - this.tremPos) >> (this.regs[0xBD] & 0x80 ? 2 : 4);
    if ((this.timer & 1023) === 0) this.vibPos = (this.vibPos + 1) & 7;
    const nb = ((this.noise >> 14) ^ this.noise) & 1; this.noise = (this.noise >> 1) | (nb << 22);
    let mix = 0;
    for (let ci = 0; ci < 9; ci++) {
      if (this.rhythm && ci >= 6) continue;   // (channels 6-8: the percussion, below)
      const c = this.ch[ci], m = this.ops[ci * 2], k = this.ops[ci * 2 + 1];
      m.ch = ci; k.ch = ci;
      this.envStep(m); this.envStep(k);
      if (m.stage === 4 && k.stage === 4) { m.out = m.prev = 0; continue; }
      const fx = this.race ? FX[ci] : null, oct = fx ? fx.oct : 0;
      const pm = this.phaseStep(m, c, oct), pk = this.phaseStep(k, c, oct);
      const fb = c.fb ? (m.prev + m.out) >> (9 - c.fb) : 0;
      const mo = waveOut(m.ws, pm + fb, this.att(m));
      m.prev = m.out; m.out = mo;
      const ko = waveOut(k.ws, pk + (c.con ? 0 : mo), this.att(k));
      mix += (c.con ? mo + ko : ko) * (fx ? fx.gain : 1);
    }
    if (this.rhythm) mix += this.percussion();
    return mix;
  }
  process(_, outputs) {
    const out = outputs[0], L = out[0], n = L.length;
    if (!this.F) { for (const c of out) c.fill(0); return true; }
    const I = this.I, F = this.F, wr = Atomics.load(I, 0);
    if (wr - this.rd > RING) this.rd = wr - RING;
    const now = currentTime, dt = 1 / sampleRate, step = SR_OPL / sampleRate;
    for (let s = 0; s < n; s++) {
      const t = now + s * dt;
      // apply writes that are due (all of them if no clock mapping yet)
      while (this.rd < wr) {
        const j = (this.rd % RING) * 2, et = F[j];
        if (this.offset != null) { const at = (et - this.offset) / 1000 + this.lat; if (at > t) break; }
        const p = F[j + 1]; this.write(p >> 8, p & 0xFF); this.rd++;
      }
      // the chip's samples, linearly interpolated to the output's rate
      this.chipT += step;
      while (this.chipT >= 1) { this.chipT -= 1; this.y0 = this.y1; this.y1 = this.chipSample(); }
      const y = (this.y0 + (this.y1 - this.y0) * this.chipT) / 4096 * 0.18;
      // the card's output stage: a DC-blocking high pass, then the page's volume
      this.dc += (y - this.dc) * 0.0005;
      L[s] = Math.max(-1, Math.min(1, (y - this.dc) * this.vol));
    }
    for (let i = 1; i < out.length; i++) out[i].set(L);
    return true;
  }
}
// the percussion voices (channels 6-8 in percussion mode), as the chip makes them: the bass drum is channel
// 6's FM pair; the hi-hat, snare and cymbal take their phases from bits of channel 7's modulator and channel
// 8's carrier mixed with noise; the tom is a plain operator. Each sounds twice as loud as a melodic channel.
OPL.prototype.percussion = function () {
  const ops = this.ops, c6 = this.ch[6], c7 = this.ch[7], c8 = this.ch[8];
  let out = 0;
  // bass drum: channel 6, FM (or the carrier alone when its connection is additive, as the chip does)
  { const m = ops[12], k = ops[13]; m.ch = k.ch = 6; this.envStep(m); this.envStep(k);
    const pm = this.phaseStep(m, c6, 0), pk = this.phaseStep(k, c6, 0);
    const fb = c6.fb ? (m.prev + m.out) >> (9 - c6.fb) : 0, mo = waveOut(m.ws, pm + fb, this.att(m));
    m.prev = m.out; m.out = mo;
    out += waveOut(k.ws, pk + (c6.con ? 0 : mo), this.att(k)) * 2; }
  const hh = ops[14], sd = ops[15], tt = ops[16], tc = ops[17];
  hh.ch = sd.ch = 7; tt.ch = tc.ch = 8;
  for (const o of [hh, sd, tt, tc]) this.envStep(o);
  const p7 = this.phaseStep(hh, c7, 0); this.phaseStep(sd, c7, 0);
  const p8t = this.phaseStep(tt, c8, 0), p8 = this.phaseStep(tc, c8, 0);
  const b2 = (p7 >> 2) & 1, b3 = (p7 >> 3) & 1, b7 = (p7 >> 7) & 1, b8 = (p7 >> 8) & 1, t3 = (p8 >> 3) & 1, t5 = (p8 >> 5) & 1;
  const x = (b2 ^ b7) | (b3 ^ t5) | (t3 ^ t5), nz = this.noise & 1;
  const pHH = (x << 9) | ((x ^ nz) ? 0xD0 : 0x34), pSD = (b8 << 9) | ((b8 ^ nz) << 8), pTC = (x << 9) | 0x80;
  if (hh.stage !== 4) out += waveOut(hh.ws, pHH, this.att(hh)) * 2;
  if (sd.stage !== 4) out += waveOut(sd.ws, pSD, this.att(sd)) * 2;
  if (tt.stage !== 4) out += waveOut(tt.ws, p8t, this.att(tt)) * 2;
  if (tc.stage !== 4) out += waveOut(tc.ws, pTC, this.att(tc)) * 2;
  return out;
};
registerProcessor('stunts-opl', OPL);
