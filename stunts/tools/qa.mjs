// Headless play-testing: runs the real page in headless Chrome, plays a scripted session (key holds and
// taps, waits) and records screenshots, single or in bursts (for motion: shadows, clouds, camera).
//
//   node stunts/tools/qa.mjs <script.json> <outdir> [--url URL] [--size 1280x600] [--port 9240]
//   (Chrome: found where it usually is on macOS, Windows and Linux; CHROME=<path> to use another)
//
// The server (stunts/tools/serve.py 8766) must be running. A script is a list of steps:
//   { "wait": ms }                         wait
//   { "down": "ArrowUp" } / { "up": "ArrowUp" }   hold / release a key (KeyboardEvent.code)
//   { "tap": "Enter", "ms": 90 }           press and release
//   { "race": true }                       title -> main menu -> Let's Drive, wait until racing
//   { "replay": true }                     load and play the DEFAULT replay
//   { "shot": "name" }                     one screenshot, outdir/name.png
//   { "burst": "name", "n": 20, "every": 80 }   n screenshots every ms: name-00.png ...
//   { "eval": "js expression" }            evaluated in the page, result printed (awaited); "save": "f.jsonl" appends it to outdir/f.jsonl
//   { "log": "text" }
//   { "rec": "name" } / { "stoprec": true }   record the screen (outdir/rec-name/NNNNN.jpg, times.json)
//   { "goto": true }                       load the page again (or "goto": URL), then wait as at the start
//   { "move": P, "ms": 600 }               the mouse glides to P (eased, 60 a second); P: [x, y] page pixels, { "sel": css }
//                                          (an element's centre), or { "game": [x, y] } (the game's 320x200 picture)
//   { "click": P }                         glide there (if P is given), press and let go
//   { "drag": P, "ms": 900 }               press, glide to P, let go
//   { "wheel": dy, "n": 3, "every": 120 }  n wheel notches of dy at the mouse
//   { "css": "text" }                      a style sheet added to the page (e.g. the HUD hidden)
//   { "grant": true }                      clipboard permission for the page (Copy code works headless)
//   { "file": css, "paths": [...] }        files put in a file input (its change event fires)
// While recording, the mouse's place and button are logged per move into rec-*/cursor.json ([epoch s, x, y, down]):
// headless captures show no cursor, so the montage draws it in.
// Steps may carry "at": ms (from the start) instead of running back to back.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const scriptFile = args[0], out = args[1];
if (!scriptFile || !out) { console.error('usage: qa.mjs script.json outdir [--url U] [--size WxH] [--port P]'); process.exit(2); }
const steps = JSON.parse(fs.readFileSync(scriptFile, 'utf8'));
const url = opt('--url', 'http://localhost:8766/stunts/?nosound');
const [W, H] = opt('--size', '1280x600').split('x').map(Number);
const port = +opt('--port', String(9240 + Math.floor(Math.random() * 500)));
fs.mkdirSync(out, { recursive: true });

// Chrome: CHROME if set, else where it usually is on this system (Chromium on Linux too)
const chrome = process.env.CHROME || ({
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
  win32: [path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe')],
}[process.platform] || ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'])
  .find(p => fs.existsSync(p));
if (!chrome) { console.error('Chrome not found: set CHROME to its path'); process.exit(2); }
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'stunts-qa-'));
const proc = spawn(chrome, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, `--window-size=${W},${H}`,
  '--enable-gpu', ...(process.platform === 'darwin' ? ['--use-angle=metal'] : []), ...(process.getuid && process.getuid() === 0 ? ['--no-sandbox'] : []), '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
  '--autoplay-policy=no-user-gesture-required', '--mute-audio', '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
// (never leave a browser running: its pages keep playing, sound included)
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { try { proc.kill('SIGKILL'); } catch (_) {} process.exit(1); });
process.on('exit', () => { try { proc.kill('SIGKILL'); } catch (_) {} });
let targets = null;
for (let i = 0; i < 100 && !targets; i++) { await sleep(100); try { targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); } catch (_) {} }
const page = targets.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let id = 0; const pending = new Map();
let rec = null;
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.method === 'Page.screencastFrame') { ws.send(JSON.stringify({ id: 900000 + (id++), method: 'Page.screencastFrameAck', params: { sessionId: m.params.sessionId } })); if (rec) { const f = path.join(rec.dir, String(rec.n).padStart(5, '0') + '.jpg'); rec.writes = (rec.writes || []); rec.writes.push(fs.promises.writeFile(f, Buffer.from(m.params.data, 'base64'))); rec.times.push([rec.n++, m.params.metadata.timestamp]); } return; }   /* (acknowledged first: the next frame comes while this one is written) */ if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') console.log('[page error]', m.params.args.map(a => a.value || a.description).join(' ')); else if (m.method === 'Runtime.exceptionThrown') console.log('[page exception]', m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description); };
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async expr => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return r.result && r.result.result ? r.result.result.value : r; };
await send('Runtime.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url });
// (until the game's page is running: the game's code is made from the game's files first, see boot.js)
const ready = async () => { for (let i = 0; i < 150; i++) { await sleep(200); if (await evaluate("typeof view !== 'undefined'")) break; } await sleep(6000); };
await ready();
const helpers = `
window.__kd = (c, d) => dispatchEvent(new KeyboardEvent(d ? 'keydown' : 'keyup', { code: c, key: /^Key[A-Z]$/.test(c) ? c.slice(3).toLowerCase() : /^Digit\d$/.test(c) ? c.slice(5) : c === 'Space' ? ' ' : c }));
window.__sleep = ms => new Promise(r => setTimeout(r, ms));
window.__tap = async (c, ms = 90) => { __kd(c, 1); await __sleep(ms); __kd(c, 0); };
window.__racing = () => typeof view !== 'undefined' && !!(view.cur && view.cur.cam);
1`;
await evaluate(helpers);
// the mouse: its place, eased glides, presses, the wheel (CDP input, as a real mouse)
let mx = W / 2, my = H / 2, mdown = false;
const logCur = () => { if (rec) (rec.cursor = rec.cursor || []).push([Date.now() / 1000, Math.round(mx), Math.round(my), mdown ? 1 : 0]); };
const mouse = (type, extra = {}) => send('Input.dispatchMouseEvent', Object.assign({ type, x: mx, y: my, button: mdown || type !== 'mouseMoved' ? 'left' : 'none', buttons: mdown ? 1 : 0, clickCount: 1 }, extra));
const point = async P => {
  if (Array.isArray(P)) return P;
  if (P && P.sel) return await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(P.sel)}).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  if (P && P.game) return await evaluate(`(() => { const r = canvas.getBoundingClientRect(); return [r.left + r.width * ${P.game[0]} / 320, r.top + r.height * ${P.game[1]} / 200]; })()`);
  return [mx, my];
};
const glide = async (P, ms = 600) => {
  const [x1, y1] = await point(P), x0 = mx, y0 = my, n = Math.max(1, Math.round(ms / 16.7)), t0 = Date.now();
  for (let i = 1; i <= n; i++) {
    const t = i / n, e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;   // (ease in and out)
    mx = x0 + (x1 - x0) * e; my = y0 + (y1 - y0) * e; await mouse('mouseMoved'); logCur();
    const d = t0 + i * 16.7 - Date.now(); if (d > 0) await sleep(d);
  }
};
const shot = async file => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, file + '.png'), Buffer.from(r.result.data, 'base64')); };
const t0 = Date.now();
for (const s of steps) {
  if (s.at != null) { const d = s.at - (Date.now() - t0); if (d > 0) await sleep(d); }
  if (s.goto) { await send('Page.navigate', { url: s.goto === true ? url : s.goto }); await ready(); await evaluate(helpers); }
  if (s.wait) await sleep(s.wait);
  if (await evaluate('typeof __tap')  !== 'function') await evaluate(helpers);   // (the page was reloaded)
  if (s.down) await evaluate(`__kd(${JSON.stringify(s.down)}, 1)`);
  if (s.up) await evaluate(`__kd(${JSON.stringify(s.up)}, 0)`);
  if (s.tap) await evaluate(`__tap(${JSON.stringify(s.tap)}, ${s.ms || 90})`);
  if (s.race) { await evaluate(`(async () => { await __tap('Enter'); await __sleep(4500); await __tap('Enter'); for (let i = 0; i < 120 && !__racing(); i++) await __sleep(250); await __sleep(1500); return __racing(); })()`).then(v => console.log('racing:', v)); }
  if (s.replay) { await evaluate(`(async () => { await __tap('Enter'); await __sleep(4500); await __tap('Enter'); await __sleep(8000); await __tap('Escape'); await __sleep(2000); await __tap('Enter'); await __sleep(1500); for (let i = 0; i < 3; i++) { await __tap('ArrowDown'); await __sleep(400); } await __tap('Enter'); await __sleep(2000); await __tap('Enter'); await __sleep(4000); for (let i = 0; i < 3; i++) { await __tap('ArrowRight'); await __sleep(300); } await __tap('Enter'); return 1; })()`); }
  if (s.rec) {
    const dir = path.join(out, 'rec-' + s.rec); fs.mkdirSync(dir, { recursive: true }); rec = { dir, n: 0, times: [], opl: [], gf: [] };
    await send('Page.startScreencast', { format: 'jpeg', quality: 88, everyNthFrame: 1 });
    // the sound chip's register writes (the page's shared ring: epoch ms, register << 8 | value), when sound is on
    await evaluate(`window.__oplRd = typeof audio !== 'undefined' && audio ? ${s.oplFromStart ? 0 : 'new Int32Array(audio, 0, 2)[0]'} : -1, 1`);
    const r0 = rec;
    r0.regs = await evaluate(`typeof audio !== 'undefined' && audio ? Array.from(new Uint8Array(audio, 8, 256)) : null`);   // the chip's state at the start
    r0.poll = (async () => { while (rec === r0) { const v = await evaluate(`(() => { const D = StuntsCode.DSEG << 4, g = [performance.timeOrigin + performance.now(), mem[D + StuntsCode.SYM.state + 320] | mem[D + StuntsCode.SYM.state + 321] << 8], o = []; if (__oplRd >= 0) { const I = new Int32Array(audio, 0, 2), F = new Float64Array(audio, 512, 8192 * 2), n = I[0]; for (let i = Math.max(__oplRd, n - 8192); i < n; i++) { const j = (i % 8192) * 2; o.push(F[j], F[j + 1]); } __oplRd = n; } return [g, o]; })()`); if (Array.isArray(v)) { r0.gf.push(v[0]); r0.opl.push(...v[1]); } await sleep(300); } })();   // (the sound chip's writes and the game's frame counter, to line up recordings; one light call, rarely: the page must keep its frames)
  }
  if (s.stoprec && rec) {
    await send('Page.stopScreencast'); const r0 = rec; rec = null; await r0.poll; await sleep(200); await Promise.all(r0.writes || []);
    fs.writeFileSync(path.join(r0.dir, 'times.json'), JSON.stringify(r0.times)); fs.writeFileSync(path.join(r0.dir, 'frames.json'), JSON.stringify(r0.gf));
    if (r0.cursor) fs.writeFileSync(path.join(r0.dir, 'cursor.json'), JSON.stringify(r0.cursor));
    if (r0.opl.length) fs.writeFileSync(path.join(r0.dir, 'opl.json'), JSON.stringify({ regs: r0.regs, writes: r0.opl }));
    console.log('recorded', r0.n, 'frames', r0.opl.length / 2, 'sound writes');
  }
  if (s.move) await glide(s.move, s.ms || 600);
  if (s.click) { if (s.click !== true) await glide(s.click, s.ms || 500); mdown = true; await mouse('mousePressed'); logCur(); await sleep(90); mdown = false; await mouse('mouseReleased'); logCur(); }
  if (s.drag) { mdown = true; await mouse('mousePressed'); logCur(); await sleep(60); await glide(s.drag, s.ms || 900); await sleep(60); mdown = false; await mouse('mouseReleased'); logCur(); }
  if (s.wheel) { for (let i = 0; i < (s.n || 1); i++) { await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: mx, y: my, deltaX: 0, deltaY: s.wheel }); logCur(); await sleep(s.every || 120); } }
  if (s.css) await evaluate(`(() => { const st = document.createElement('style'); st.textContent = ${JSON.stringify(s.css)}; document.head.appendChild(st); return 1; })()`);
  if (s.grant) { const o = new URL(url).origin; console.log('grant', JSON.stringify(await send('Browser.grantPermissions', { origin: o, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] }))); }
  if (s.file) { const d = await send('DOM.getDocument', { depth: -1 }); const q = await send('DOM.querySelector', { nodeId: d.result.root.nodeId, selector: s.file }); await send('DOM.setFileInputFiles', { nodeId: q.result.nodeId, files: s.paths.map(f => path.resolve(f)) }); }
  if (s.shot) await shot(s.shot);
  if (s.burst) { const n = s.n || 10, every = s.every || 100; for (let i = 0; i < n; i++) { const t = Date.now(); await shot(`${s.burst}-${String(i).padStart(2, '0')}`); const d = every - (Date.now() - t); if (d > 0) await sleep(d); } }
  if (s.eval) { const v = await evaluate(s.eval); console.log('eval:', JSON.stringify(v)); if (s.save) fs.appendFileSync(path.join(out, s.save), JSON.stringify(v) + '\n'); }
  if (s.log) console.log(s.log);
}
ws.close(); proc.kill('SIGKILL');
try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
process.exit(0);
