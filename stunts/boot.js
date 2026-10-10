// The game's code, made in this browser from your own copy: the program (exefile.js) translated with the map
// (map.json: names and places only, see tools/mkmap.py) by translate.js, checked against the map's checksum of the
// translation, then loaded as a script the page and the worker both run.
//   StuntsBoot.code(files, exe) -> Promise of { url, procs } (exe: a GAME.EXE's bytes, for the developer copy);
//   rejects with a message for the player when the files are not a Stunts 1.1 the map fits
'use strict';
(function (root) {
  let map = null, made = null;
  const getMap = () => map || (map = fetch('map.json?v=__BUILD__').then(r => { if (!r.ok) throw new Error('map.json: ' + r.status); return r.json(); }));
  async function sha256(text) {
    const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
    return Array.from(h, b => b.toString(16).padStart(2, '0')).join('');
  }
  async function code(files, exe) {
    if (made && made.from === (exe || files)) return made;   // (made once per copy: a different copy is checked and made afresh)
    const prog = StuntsExe.fromFiles(exe ? { 'GAME.EXE': exe } : files);
    if (!prog) throw new Error("The game's program is missing: the zip needs GAME.EXE, or EGA.CMN and the MCGA files (MCGA.HDR, MCGA.DIF, MCGA.COD).");
    const m = await getMap(), t0 = performance.now();
    let out;
    try { out = StuntsTranslate(prog, m); } catch (_) { out = null; }
    if (!out || await sha256(out.source) !== m.sum)
      throw new Error("This copy's program is not the Stunts 1.1 this page knows (it may be another version, or changed). Try the files of an original Stunts 1.1.");
    console.log('[boot] game code translated from your copy in', Math.round(performance.now() - t0), 'ms:', out.procs, 'procs');
    if (made) URL.revokeObjectURL(made.url);
    made = { url: URL.createObjectURL(new Blob([out.source], { type: 'text/javascript' })), procs: out.procs, from: exe || files };
    return made;
  }
  root.StuntsBoot = { code };
})(self);
