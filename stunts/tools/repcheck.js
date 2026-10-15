// Replay check: plays replays through the translated game the way Chocolate Stunts' repldump does (the game's own
// start-up up to init_kevinrandom, then load the replay, set up the race, and step update_gamestate frame by frame),
// and compares the race state after every frame with a dump from the original game in DOS: STEM.BIN, made by
// Chocolate Stunts' archived tools/oracles/borland/repldumo.exe in DOSBox-X (`REPLDUMO.EXE STEM.RPL 1`, in a copy of
// the game's files with the replays' custom cars, tools/scripts/cars, beside it).
//   node repcheck.js <dir with STEM.BIN> <replay.rpl>...
// prints a line per replay: "ok STEM frames/frames", "DESYNC STEM frame F/frames field+offset dos>ours, ..." or "ERROR STEM ..."
// env: DATA (the game's files, default vendor/restunts/stunts), BUMPFIX (the page's bump-bug fix, as worker.js has it),
//   VERBOSE, DUMP=<dir> (a desynced frame's state), SIV (SI before each frame, default 80 as repldumo has it)
//   JUNK=1 plays each replay again with junk in the unused stack before every frame, JUNK=only just that: a replay that
//     then plays differently reads what was left on the stack between frames (by the renderer, in the game)
//   RENDER=og|hd draws every frame too, as Chocolate Stunts' pixldump does (camera CAM, default 1, whole screen), with
//     the original's renderer or the page's (hires-capture.js; KEEP=1 keeps the original's running under it).
//     PDO=<dir> writes the screen hashes as pixldumo.exe does (STEM.PDO, to compare with its); STATES=<dir> writes
//     every frame's state (STEM.ST) and reports the first difference; NOBIN=1 runs without a .BIN
//   SPADJ=<bytes> runs the frames with the stack that much deeper: the original's penalty check (detect_penalty) can
//     mark a route piece as seen at a wild index, a byte written wherever the stack's place puts it (2155-2164 in
//     Chocolate Stunts' replays desync here by default, and play as in DOS with the stack 16 bytes or more deeper)
// debugging: WATCH=<DSEG offset> WFRAME=<n> who writes there in frame n; WATCHALL=<DSEG offset> every write there;
//   SCAN=1 WFRAME=<n> nudges each byte frame n reads, one at a time, and names those that change it (or match DOS)
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'cpu.js')); require(process.env.CODE || path.join(ROOT, 'gen/code.js')); require(path.join(ROOT, 'drv86.js')); require(path.join(ROOT, 'dos.js')); require(path.join(ROOT, 'hires-capture.js'));
const DATA = process.env.DATA || path.join(ROOT, '../vendor/restunts/stunts');
const ORACLE = process.argv[2], REPLAYS = process.argv.slice(3);
const base = {};
for (const f of fs.readdirSync(DATA)) base[f.toUpperCase()] = new Uint8Array(fs.readFileSync(path.join(DATA, f)));

const C = StuntsCode, D = C.DSEG, SYM = C.SYM, GS = C.STRUCTS.GAMESTATE, GI = C.STRUCTS.GAMEINFO;
const P0 = Object.assign({}, C.P);   // the untouched procs: each run patches its own copy in
const FIELDS = Object.entries(GS.fields).sort((a, b) => a[1] - b[1]);
const CS = C.STRUCTS.CARSTATE && Object.entries(C.STRUCTS.CARSTATE.fields).sort((a, b) => a[1] - b[1]);
function field(off) {   // a GAMESTATE byte offset, by name
  let f = FIELDS[0]; for (const e of FIELDS) if (e[1] <= off) f = e;
  if ((f[0] === 'playerstate' || f[0] === 'opponentstate') && CS) { let c = CS[0]; for (const e of CS) if (e[1] <= off - f[1]) c = e; return f[0] + '.' + c[0] + '+' + (off - f[1] - c[1]); }
  return f[0] + '+' + (off - f[1]);
}

function murmur3(b) {   // MurmurHash3_x86_32, seed 0 (Chocolate Stunts' pixldump)
  let h = 0; const n = b.length & ~3;
  for (let i = 0; i < n; i += 4) {
    let k = b[i] | b[i + 1] << 8 | b[i + 2] << 16 | b[i + 3] << 24;
    k = Math.imul(k, 0xcc9e2d51); k = k << 15 | k >>> 17; k = Math.imul(k, 0x1b873593);
    h ^= k; h = h << 13 | h >>> 19; h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }
  let k = 0; const t = b.length & 3;
  if (t >= 3) k ^= b[n + 2] << 16; if (t >= 2) k ^= b[n + 1] << 8; if (t >= 1) { k ^= b[n]; k = Math.imul(k, 0xcc9e2d51); k = k << 15 | k >>> 17; k = Math.imul(k, 0x1b873593); h ^= k; }
  h ^= b.length; h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return (h >>> 0).toString(16).padStart(8, '0');
}

function run(rpl, junk) {
  const stem = path.basename(rpl).replace(/\.rpl$/i, '').toUpperCase();
  const size = GS.size, RENDER = process.env.RENDER;
  const bin = process.env.NOBIN ? null : fs.readFileSync(path.join(ORACLE, stem + '.BIN'));
  const want = bin ? bin.readUInt16LE(0) : -1;
  if (bin && bin.length !== 2 + want * size) return 'ERROR ' + stem + ' oracle size ' + bin.length;
  const states = [];
  Object.assign(C.P, P0);
  const files = Object.assign({}, base); files[stem + '.RPL'] = new Uint8Array(fs.readFileSync(rpl));
  let vt = 0;
  const pc = new StuntsPC(C, { files, now: () => vt, log: s => { if (process.env.VERBOSE) console.log('[dos]', s); }, onExit: c => { throw new HostExit(c); } });
  pc.hook = () => { vt += 0.5; };
  if (process.env.WATCHALL) {   // (debugging: every write to DSEG:WATCHALL, from the start)
    const lin = (D << 4) + +process.env.WATCHALL;
    for (const fn of ['wb', 'ww', 'wd']) { const o = pc[fn]; pc[fn] = function (sg, of, v) { const a = ((sg << 4) + (of & 0xFFFF)) & 0xFFFFF, w = fn === 'wb' ? 1 : fn === 'ww' ? 2 : 4; if (lin >= a && lin < a + w) console.log('WRITE', fn, 'at', a.toString(16), sg.toString(16) + ':' + (of & 0xFFFF).toString(16), 'value', v, 'frame', pc.rw(D, SYM.state + GS.fields.game_frame), new Error().stack.split('\n').filter(l => /P\./.test(l)).slice(0, 8).map(l => l.trim().split(' ')[1]).join(' < ')); return o.call(this, sg, of, v); }; }
    const ostr = pc.str; if (ostr) pc.str = function (...a) { const before = pc.mem[lin]; const ret = ostr.apply(this, a); if (pc.mem[lin] !== before) console.log('STRING-OP wrote', pc.mem[lin], new Error().stack.split('\n').filter(l => /P\./.test(l)).slice(0, 8).map(l => l.trim().split(' ')[1]).join(' < ')); return ret; };
  }
  const P = C.P, rb = o => pc.rb(D, o), rw = o => pc.rw(D, o), wb = (o, v) => pc.wb(D, o, v), ww = (o, v) => pc.ww(D, o, v);
  P.fatal_error = function (r, m) { throw new HostExit('fatal: ' + m.cstr(r.ds, m.rw(r.ss, r.sp + 4))); };
  if (process.env.BUMPFIX) { const ug = P0.update_grip; P.update_grip = function (r, m, PP, e) {   // (the page's bump-bug fix, as worker.js has it)
    const cs = pc.rw(r.ss, (r.sp + 4) & 0xFFFF), ret = ug(r, m, PP, e);
    let w = pc.rw(D, cs + 54); if (w > 32767) w -= 65536;
    if (w < 0 && w > -16 && pc.rw(D, cs + 62) === 0 && !pc.rb(D, SYM.is_in_replay)) pc.ww(D, cs + 54, (-((-w * 15) >> 4)) & 0xFFFF);
    return ret; }; }
  if (RENDER === 'hd') StuntsHires.install(pc, C, new SharedArrayBuffer(StuntsHires.BYTES), new SharedArrayBuffer(256000), { world: new SharedArrayBuffer(StuntsHires.WBYTES), keepOriginal: !!process.env.KEEP });
  const str = s => { const o = 0xFE00 + (str.n = ((str.n || 0) + 32) % 256); for (let i = 0; i <= s.length; i++) wb(o + i, i < s.length ? s.charCodeAt(i) : 0); return o; };
  let result = null;
  P.init_kevinrandom = function (r, m, PP, e) {
    const ret = P0.init_kevinrandom(r, m, PP, e);
    // a far call with C arguments: pushed last to first, popped by the caller
    const call = (name, ...args) => { for (let i = args.length - 1; i >= 0; i--) pc.push(r, args[i] & 0xFFFF); pc.call(r, P, name, 4); r.sp = (r.sp + 2 * args.length) & 0xFFFF; return r.ax; };
    const gc = SYM.gameconfig;
    call('file_load_replay', str(''), str(stem));
    // copy the track (as the game's main loop does before track_setup)
    for (let i = 0; i < GI.size; i++) wb(SYM.gameconfigcopy + i, rb(gc + i));
    const far = s => [rw(SYM[s]), rw(SYM[s] + 2)];
    const [eo, es] = far('td14_elem_map_main'), [ao, as] = far('td20_trk_file_appnd');
    for (let i = 0; i < 0x70A; i++) pc.wb(as, ao + i, pc.rb(es, eo + i));
    for (let i = 0; i < 0x51; i++) { pc.wb(as, ao + 0x70A + i, rb(SYM.byte_3B80C + i)); pc.wb(as, ao + 0x75B + i, rb(SYM.byte_3B85E + i)); }
    call('track_setup');
    const cvx = call('mmgr_alloc_resbytes', str('cvx'), 22400, 0); ww(SYM.cvxptr, cvx); ww(SYM.cvxptr + 2, r.dx);
    call('init_game_state', 0xFFFF);
    // run_game's own start
    ww(SYM.word_449EA, 0xFFFF);
    ww(SYM.run_game_random, call('get_kevinrandom') << 3);
    wb(SYM.replaybar_toggle, 1); wb(SYM.is_in_replay, 0); wb(SYM.idle_expired, 0); wb(SYM.cameramode, 0);
    wb(SYM.game_replay_mode, 2); wb(SYM.is_in_replay, 1);
    if (RENDER) { wb(SYM.replaybar_toggle, 0); wb(SYM.detail_level, 0); ww(SYM.slow_video_mgmt, 1); ww(SYM.slow_video_mgmt_copy, 1); }
    if (call('setup_player_cars') !== 0) throw new HostExit('setup_player_cars: out of memory');
    wb(SYM.kbormouse, 0); wb(SYM.byte_449E6, 0); wb(SYM.byte_449DA, 1);
    call('set_frame_callback');
    wb(SYM.game_replay_mode_copy, 0xFF); wb(SYM.byte_44346, 0); wb(SYM.byte_4432A, 0); wb(SYM.byte_46467, 0); wb(SYM.dashb_toggle, 0);
    wb(SYM.cameramode, RENDER ? (+process.env.CAM || 1) - 1 : 0); wb(SYM.game_replay_mode, 2); ww(SYM.word_44DCA, 500); ww(SYM.framespersec, 20);
    const rw0 = SYM.rect_windshield;
    if (RENDER) { wb(SYM.followOpponentFlag, 0); ww(rw0, 0); ww(rw0 + 2, 320); ww(rw0 + 4, 0); ww(rw0 + 6, 200); call('set_projection', 35, 200 / 6 | 0, 320, 200); }
    call('restore_gamestate', 0);
    const frames = rw(gc + GI.fields.game_recordedframes);
    call('restore_gamestate', frames);
    const st = SYM.state, fr = st + GS.fields.game_frame;
    const draw = () => { call('sprite_copy_wnd_to_1'); call('update_frame', 0, rw0); call('sub_19F14', rw0); call('mouse_draw_opaque_check'); if (rb(SYM.byte_454A4)) wb(SYM.byte_454A4, rb(SYM.byte_454A4) - 1); if (pdo) pdo.push(rw(fr) + ' ' + murmur3(pc.mem.subarray(0xA0000, 0xA0000 + 64000))); };
    const pdo = process.env.PDO ? ['PIXLDUMP 2'] : null;
    if (RENDER) { call('init_rect_arrays'); wb(SYM.byte_454A4, 1); draw(); }
    if (bin && frames !== want) { result = 'DESYNC ' + stem + ' recorded frames ' + frames + ' vs ' + want; throw new HostExit('done'); }
    if (process.env.SPADJ) r.sp = (r.sp - +process.env.SPADJ) & 0xFFFF;   // (debugging: the stack deeper by SPADJ bytes for the frames)
    let n = 0;
    while (frames > rw(fr)) {
      call('input_do_checking', 1);
      if (junk) for (let a = 1; a <= 2048; a++) pc.wb(r.ss, (r.sp - a) & 0xFFFF, (a * 167 + n * 31 + 0x5A) & 0xFF);   // (stack below SP: what the frame before left there, made junk)
      if (process.env.WATCH && n === +process.env.WFRAME) {   // (debugging: who writes DSEG:WATCH in frame WFRAME)
        const wa = +process.env.WATCH, lin = (D << 4) + wa;
        for (const fn of ['wb', 'ww']) { const o = pc[fn]; pc[fn] = function (sg, of, v) { const a = ((sg << 4) + of) & 0xFFFFF; if (a === lin || (fn === 'ww' && a + 1 === lin)) console.log('WRITE', fn, v, new Error().stack.split('\n').filter(l => /P\./.test(l)).slice(0, 8).map(l => l.trim().split(' ')[1]).join(' < ')); return o.call(this, sg, of, v); }; }
      }
      r.si = process.env.SIV != null ? +process.env.SIV : 80;   // (SI as repldumo's dump loop has it, 80: the physics can read SI as update_grip saved it, for a wheel's contact distance)
      if (process.env.SCAN && n === +process.env.WFRAME) {   // (debugging: which bytes read in frame WFRAME change it; nudged one at a time from a snapshot)
        const mem0 = pc.mem.slice(), r0 = Object.assign({}, r), want1 = bin.subarray(2 + n * size, 2 + (n + 1) * size);
        const reads = new Map(), orb = pc.rb, orw = pc.rw, rd = pc.rd;
        const lin = (sg, of) => ((sg << 4) + (of & 0xFFFF)) & 0xFFFFF;
        pc.rb = function (sg, of) { const a = lin(sg, of); if (!reads.has(a)) reads.set(a, this.mem[a]); return orb.call(this, sg, of); };
        pc.rw = function (sg, of) { for (const a of [lin(sg, of), lin(sg, of + 1)]) if (!reads.has(a)) reads.set(a, this.mem[a]); return orw.call(this, sg, of); };
        call('update_gamestate');
        const base1 = pc.mem.slice((D << 4) + st, (D << 4) + st + size);
        pc.rb = orb; pc.rw = orw;
        const ss = (r0.ss << 4), stack = a => a >= ss + ((r0.sp - 4096) & 0xFFFF) && a < ss + 0x10000 && (r.ss === r0.ss);
        console.log('bytes read', reads.size);
        let hits = 0;
        for (const [a, v] of reads) {
          for (const dv of [1, 0x40]) {
            pc.mem.set(mem0); Object.assign(r, r0); pc.mem[a] = v ^ dv;
            call('update_gamestate');
            const got = pc.mem.subarray((D << 4) + st, (D << 4) + st + size);
            let same = true, match = true; for (let i = 0; i < size; i++) { if (got[i] !== base1[i]) same = false; if (got[i] !== want1[i]) match = false; }
            if (match) console.log('MATCHES DOS when', a.toString(16), 'is', (v ^ dv), 'not', v, (a >> 4).toString(16) + ':' + (a & 15).toString(16), 'DSEG+' + (a - (D << 4)));
            if (!same && hits++ < 400 && !stack(a)) console.log('changes', a.toString(16), 'DSEG+' + (a - (D << 4)), 'value', v);
          }
        }
        throw new HostExit('scan done');
      }
      call('update_gamestate');
      if (RENDER) draw();
      if (process.env.STATES) { for (let i = 0; i < size; i++) states.push(rb(st + i)); n++; continue; }
      if (n >= want) { result = 'DESYNC ' + stem + ' more frames than ' + want; throw new HostExit('done'); }
      const o = 2 + n * size;
      for (let i = 0; i < size; i++) if (rb(st + i) !== bin[o + i]) {
        const got = []; for (let k = 0; k < size; k++) got.push(rb(st + k));
        if (process.env.DUMP) fs.writeFileSync(path.join(process.env.DUMP, stem + '.frame' + n), Buffer.from(got));
        const diffs = []; for (let k = 0; k < size && diffs.length < 6; k++) if (got[k] !== bin[o + k]) diffs.push(field(k) + ' ' + bin[o + k] + '>' + got[k]);
        result = (junk ? 'JUNK-' : '') + 'DESYNC ' + stem + ' frame ' + n + '/' + want + ' ' + diffs.join(', '); throw new HostExit('done');
      }
      n++;
    }
    if (pdo) fs.writeFileSync(path.join(process.env.PDO, stem + '.PDO'), pdo.join('\r\n') + '\r\n');
    if (process.env.STATES) {
      const got = Buffer.from(states); fs.writeFileSync(path.join(process.env.STATES, stem + '.ST'), got);
      if (!bin) { result = 'done ' + stem + ' ' + n; throw new HostExit('done'); }
      let f = -1; for (let i = 0; i < Math.min(got.length, bin.length - 2); i++) if (got[i] !== bin[2 + i]) { f = i; break; }
      result = (f < 0 && n === want ? 'ok ' : 'DESYNC ') + stem + ' ' + n + '/' + want + (f < 0 ? '' : ' first at frame ' + Math.floor(f / size) + ' ' + field(f % size));
      throw new HostExit('done');
    }
    result = (junk ? 'JUNK-' : '') + (n === want ? 'ok ' : 'DESYNC ') + stem + ' ' + n + '/' + want;
    throw new HostExit('done');
    return ret;   // (not reached)
  };
  try { pc.start([]); } catch (e) { if (!(e instanceof HostExit)) return 'ERROR ' + stem + ' ' + String(e.stack || e).split('\n').slice(0, 3).join(' | '); if (!result) return 'ERROR ' + stem + ' ' + e.message; }
  return result || 'ERROR ' + stem + ' never reached the replay';
}

for (const f of REPLAYS) {
  if (process.env.JUNK !== 'only') console.log(run(f, false));
  if (process.env.JUNK) console.log(run(f, true));
}
