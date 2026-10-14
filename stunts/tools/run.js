// Headless run of the translated game. Virtual clock: every poll advances time a little, so runs
Error.stackTraceLimit = 60;
// are repeatable. usage: node run.js <outdir> [script.json]
// script: [{"at": ms, "key": scancode, "up": bool} | {"at": ms, "shot": "name"}]
'use strict';
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'cpu.js')); require(process.env.CODE || path.join(ROOT, 'gen/code.js')); require(path.join(ROOT, 'drv86.js')); require(path.join(ROOT, 'dos.js')); require(path.join(ROOT, 'hires-capture.js'));
const OUT = process.argv[2] || '/tmp';
const script = process.argv[3] ? JSON.parse(fs.readFileSync(process.argv[3], 'utf8')) : [];
const DATA = process.env.DATA || path.join(ROOT, '../vendor/restunts/stunts');   // (DATA: another copy of the game's files)
const files = {};
for (const f of fs.readdirSync(DATA)) files[f.toUpperCase()] = new Uint8Array(fs.readFileSync(path.join(DATA, f)));

function png(pc, file) {
  const w = 320, h = 200, raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = pc.mem[0xA0000 + y * w + x], o = y * (w * 3 + 1) + 1 + x * 3;
    raw[o] = pc.pal[c * 3] * 255 / 63; raw[o + 1] = pc.pal[c * 3 + 1] * 255 / 63; raw[o + 2] = pc.pal[c * 3 + 2] * 255 / 63;
  }
  const crc = b => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = c >>> 1 ^ (0xEDB88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 2;
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

let vt = 0, polls = 0;
const limit = +(process.env.LIMIT || 60000);
const pc = new StuntsPC(StuntsCode, {
  files, now: () => vt,
  log: s => { if (process.env.VERBOSE) console.log('[dos]', s); },
  onExit: c => { throw new HostExit(c); },
});
const origFatal = StuntsCode.P.fatal_error;
StuntsCode.P.fatal_error = function (r, m, P, e) {
  const fmt = m.cstr(r.ds, m.rw(r.ss, r.sp + 4));
  console.log('stack', [0,2,4,6,8,10,12].map(o => m.rw(r.ss, r.sp + o).toString(16)).join(' '), 'sp', r.sp.toString(16), 'bp', r.bp.toString(16));
  console.log('FATAL:', JSON.stringify(fmt), 'args', [6, 8, 10].map(o => m.rw(r.ss, r.sp + o).toString(16)).join(' '), 'arg0 str:', JSON.stringify(m.cstr(r.ds, m.rw(r.ss, r.sp + 6))));
  if (process.env.TRACE) console.log(new Error().stack.split('\n').filter(l => /P\./.test(l)).slice(0, 30).map(l => l.trim().split(' ')[1]).join(' < '));
  throw new HostExit('fatal');
};
if (process.env.WATCH) {
  const [ws, wo] = process.env.WATCH.split(':').map(x => parseInt(x, 16)), wl = (ws << 4) + wo;
  const chk = (name) => { const v = pc.mem[wl] | (pc.mem[wl + 1] << 8); if (v !== chk.v) { console.log('WATCH', name, chk.v && chk.v.toString(16), '->', v.toString(16), new Error().stack.split('\n').filter(l => /P\./.test(l)).slice(0, 6).map(l => l.trim().split(' ')[1]).join(' < ')); chk.v = v; } };
  chk.v = pc.mem[wl] | (pc.mem[wl + 1] << 8);
  for (const fn of ['wb', 'ww', 'wd', 'str']) { const o = pc[fn].bind(pc); pc[fn] = (...a) => { const r = o(...a); chk(fn); return r; }; }
}
let wire = null;
if (process.env.HIRES) { const sc = globalThis.__scene = new SharedArrayBuffer(StuntsHires.BYTES); const back = new Uint8Array(64000); StuntsHires.install(pc, StuntsCode, sc, new SharedArrayBuffer(128000), { world: (globalThis.__world = new SharedArrayBuffer(StuntsHires.WBYTES)), keepOriginal: !process.env.NOKEEP, onRastered: ra => { for (let y = 0; y < 200; y++) { const a = ra(y); back.set(pc.mem.subarray(a, a + 320), y * 320); } } }); if (process.env.DIFF) { const d = require(process.env.DIFF)(pc, StuntsCode, sc, back); wire = () => d(path.join(OUT, 'soft.png')); } }
if (process.env.BUMPFIX) { const ug = StuntsCode.P.update_grip; StuntsCode.P.update_grip = function (r, m, P, e) {   // (the page's bump-bug fix, as worker.js has it)
  const cs = pc.rw(r.ss, (r.sp + 4) & 0xFFFF), ret = ug(r, m, P, e), Dg = StuntsCode.DSEG;
  let w = pc.rw(Dg, cs + 54); if (w > 32767) w -= 65536;
  if (w < 0 && w > -16 && pc.rw(Dg, cs + 62) === 0 && !pc.rb(Dg, StuntsCode.SYM.is_in_replay)) pc.ww(Dg, cs + 54, (-((-w * 15) >> 4)) & 0xFFFF);
  return ret; }; }
if (process.env.VTEST) require(process.env.VTEST)(pc, StuntsCode);
const queue = script.slice().sort((a, b) => a.at - b.at);
let lastShot = 0;
pc.hook = now => {
  vt += +(process.env.STEP || 0.5); polls++; if (pc.hook2) pc.hook2();
  while (queue.length && queue[0].at <= now) {
    const e = queue.shift();
    if (e.key != null) pc.keyEvent(e.key, !e.up, e.ascii || 0);
  }
  if (process.env.EVERY && now - lastShot >= +process.env.EVERY) { lastShot = now; if (wire) { wire(); require('fs').renameSync(path.join(OUT, 'soft.png'), path.join(OUT, 'soft-' + String(Math.round(now)).padStart(6, '0') + '.png')); } png(pc, path.join(OUT, 'auto-' + String(Math.round(now)).padStart(6, '0') + '.png')); }
  if (globalThis.__drift) globalThis.__drift();
  if (now > limit) { if (process.env.TRACE) console.log(new Error().stack.split('\n').filter(l => /P\./.test(l)).slice(0, 30).map(l => l.trim().split(' ')[1]).join(' < ')); throw new HostExit('time limit'); }
};
const t0 = Date.now();
try {
  pc.start((process.env.ARGS || '').split(' ').filter(Boolean));
  console.log('main returned', pc.r.ax);
} catch (e) {
  if (e instanceof HostExit) console.log('exit', e.code);
  else { console.log('ERROR', e.stack.split('\n').slice(0, 12).join('\n')); }
}
{ let nz = 0; for (let i = 0; i < 64000; i++) if (pc.mem[0xA0000 + i]) nz++; console.log('vga nonzero', nz, 'palette nonzero', pc.pal.filter(x => x).length, 'mode', pc.videoMode); }
console.log('virtual ms', Math.round(vt), 'real ms', Date.now() - t0, 'polls', polls);
png(pc, path.join(OUT, 'last.png'));
