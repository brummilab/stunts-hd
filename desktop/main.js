// Stunts HD as a desktop app: the website's own build (dist/, from stunts/tools/site.py) served to a window under
// app://stunts/ with the headers the site sends (the game's memory is shared with its worker, which needs the page
// cross-origin isolated). Nothing of the game is in the app: the welcome screen asks for your copy, as on the site,
// and here can also open your Stunts folder (or zip) with the system's own dialog.
//   npm start                   run it (dist/ built first: python3 stunts/tools/site.py)
//   npm run selftest -- <dir>   open the game from <dir> without the dialog, start a race, save a screenshot, quit
//   npm run dist                the downloads for macOS, Windows and Linux into out/ (dist/ built first; map.json left out)
'use strict';
const { app, BrowserWindow, protocol, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path'), fs = require('fs');

const SITE = app.isPackaged ? path.join(process.resourcesPath, 'site') : path.join(__dirname, '..', 'dist');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };
const ISOLATED = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Resource-Policy': 'same-origin' };

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);

const args = process.argv.slice(app.isPackaged ? 1 : 2);
const selftest = args.includes('--selftest') ? path.resolve(args[args.indexOf('--selftest') + 1] || '') : null;

// the game's files from a folder (any depth, as a zip of one would have them) or a zip, for the welcome screen to read
const GAME_FILE = /\.(RES|P3S|3SH|PVS|VSH|XVS|PES|ESH|PRE|FNT|TRK|RPL|DRV|VCE|SFX|KMS|PLB|TD|HIG|EXE|CMN|HDR|DIF|COD|ZIP)$/i;
function readGame(p) {
  const out = [];
  const walk = (d, depth) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory() && depth < 4 && !e.name.startsWith('.')) walk(f, depth + 1);
      else if (e.isFile() && GAME_FILE.test(e.name) && out.length < 2000) out.push({ name: e.name, data: fs.readFileSync(f) });
    }
  };
  if (fs.statSync(p).isDirectory()) walk(p, 0); else out.push({ name: path.basename(p), data: fs.readFileSync(p) });
  return out;
}

ipcMain.handle('pick-game', async e => {
  if (selftest) return readGame(selftest);
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showOpenDialog(win, {
    title: 'Open your Stunts folder', buttonLabel: 'Open',
    properties: ['openDirectory', 'openFile'], filters: [{ name: 'Stunts folder or zip', extensions: ['zip'] }],
  });
  return r.canceled || !r.filePaths.length ? null : readGame(r.filePaths[0]);
});

// map.json (the names and places the game's code is translated by, from the Restunts disassembly) isn't in the app's
// download: the first time, it comes from the site, as it does for the website, and is kept beside the app's settings
const MAP_URL = 'https://stunts-recomp.pages.dev/stunts/map.json';
async function mapJson() {
  const keep = path.join(app.getPath('userData'), 'map-' + app.getVersion() + '.json');
  if (fs.existsSync(keep)) return fs.readFileSync(keep);
  const r = await fetch(MAP_URL);
  if (!r.ok) throw new Error('map.json: ' + r.status);
  const b = Buffer.from(await r.arrayBuffer());
  try { fs.writeFileSync(keep, b); } catch (_) {}
  return b;
}

function serve() {
  protocol.handle('app', async req => {
    const u = new URL(req.url);
    let p = decodeURIComponent(u.pathname);
    if (p.endsWith('/')) p += 'index.html';
    const f = path.normalize(path.join(SITE, p));
    if (p === '/stunts/map.json' && !fs.existsSync(f)) {
      try { return new Response(await mapJson(), { headers: Object.assign({ 'Content-Type': 'application/json' }, ISOLATED) }); }
      catch (e) { return new Response('map.json could not be fetched: connect to the internet once, then start again', { status: 503 }); }
    }
    if (!f.startsWith(SITE + path.sep) || !fs.existsSync(f) || !fs.statSync(f).isFile()) return new Response('Not found', { status: 404 });
    return new Response(fs.readFileSync(f), { headers: Object.assign({ 'Content-Type': TYPES[path.extname(f).toLowerCase()] || 'application/octet-stream' }, ISOLATED) });
  });
}

// the window where you left it: its size, place and whether it was fullscreen, kept beside the app's settings
const BOUNDS = () => path.join(app.getPath('userData'), 'window.json');
function lastBounds() { try { return JSON.parse(fs.readFileSync(BOUNDS(), 'utf8')); } catch (_) { return {}; } }
function keepBounds(win) {
  let t = null;
  const save = () => { clearTimeout(t); t = setTimeout(() => { try { fs.writeFileSync(BOUNDS(), JSON.stringify(Object.assign(win.isFullScreen() ? lastBounds() : win.getNormalBounds(), { full: win.isFullScreen() }))); } catch (_) {} }, 400); };
  for (const ev of ['resize', 'move', 'enter-full-screen', 'leave-full-screen']) win.on(ev, save);
}

// what the page may ask of the app besides your game's files: its version, and the window fullscreen or not
ipcMain.handle('version', () => app.getVersion());
ipcMain.handle('fullscreen', (e, on) => { const w = BrowserWindow.fromWebContents(e.sender); if (w) w.setFullScreen(!!on); });

function about(win) {
  dialog.showMessageBox(win, {
    type: 'none', title: 'About Stunts HD', message: 'Stunts HD ' + app.getVersion(),
    detail: 'Stunts / 4D Sports Driving (1990), recompiled and redrawn in HD. Your own copy of the game is needed: none of it is included.\n\n'
      + 'Open source (MIT): github.com/mr-finster/stunts-hd\nPlay in the browser: stunts-recomp.pages.dev\n\n'
      + 'Stunts © 1990 Distinctive Software / Broderbund. Not affiliated with or endorsed by them. Built on the Restunts project\'s reverse engineering; three.js (MIT).',
    buttons: ['OK', 'GitHub', 'Website'], defaultId: 0,
  }).then(r => { if (r.response === 1) shell.openExternal('https://github.com/mr-finster/stunts-hd'); if (r.response === 2) shell.openExternal('https://stunts-recomp.pages.dev/'); });
}

// the app's menu: About, the welcome screen again (to change your copy or its options), fullscreen
function menu(win) {
  const mac = process.platform === 'darwin';
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(mac ? [{ label: 'Stunts HD', submenu: [{ label: 'About Stunts HD', click: () => about(win) }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] }] : []),
    { label: 'Game', submenu: [
      { label: 'Welcome Screen', accelerator: 'CmdOrCtrl+Shift+H', click: () => win.loadURL('app://stunts/stunts/?welcome') },
      { label: 'Toggle Fullscreen', accelerator: mac ? 'Ctrl+Cmd+F' : 'F11', click: () => win.setFullScreen(!win.isFullScreen()) },
      ...(mac ? [] : [{ type: 'separator' }, { label: 'About Stunts HD', click: () => about(win) }, { role: 'quit' }]),
    ] },
    { role: 'windowMenu' },
  ]));
}

function open() {
  const b = lastBounds();
  const win = new BrowserWindow({
    width: b.width || 1280, height: b.height || 800, x: b.x, y: b.y, fullscreen: !!b.full && !selftest,
    minWidth: 640, minHeight: 400, backgroundColor: '#04061a', title: 'Stunts HD', show: !selftest,
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  // links out (YouTube, Buy Me a Coffee, the other ports) open in the browser, not in the game's window
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('app://')) { e.preventDefault(); shell.openExternal(url); } });
  keepBounds(win); menu(win);
  win.loadURL('app://stunts/stunts/');
  if (selftest) runSelftest(win);
}

async function runSelftest(win) {
  const js = s => win.webContents.executeJavaScript(s, true);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const log = (...a) => console.log('[selftest]', ...a);
  const fail = m => { log('FAIL', m); app.exit(1); };
  try {
    await new Promise(r => win.webContents.once('did-finish-load', r));
    await sleep(2500);
    log('isolated', await js('self.crossOriginIsolated'), 'host', await js('!!window.stuntsHost'));
    win.show(); await sleep(800);
    const shot = async name => { const img = await win.webContents.capturePage(); const f = path.join(app.getPath('temp'), 'stunts-selftest-' + name + '.png'); fs.writeFileSync(f, img.toPNG()); log('screenshot', f); };
    await shot('welcome');
    if (!await js('!!document.getElementById("su-open")')) return fail('no Open your Stunts folder button');
    await js('document.getElementById("su-open").click()');
    for (let i = 0; i < 60 && !await js('document.getElementById("setup").classList.contains("armed")'); i++) await sleep(500);
    log('status', await js('document.getElementById("su-status").innerText'));
    await sleep(500); await shot('ready');
    const about = 'document.querySelector("#setup nav.more .info:last-child > button")';   // the About panel, open for a picture, then closed
    await js(about + '.click()'); await sleep(1200); await shot('about'); await js(about + '.click()'); await sleep(300);
    if (!await js('document.getElementById("setup").classList.contains("armed")')) return fail('the game was not taken');
    await js('document.getElementById("su-start").click()');
    for (let i = 0; i < 60 && !await js('typeof view !== "undefined" && typeof mem !== "undefined"'); i++) await sleep(500);
    await js(`window.__kd = (c, d) => dispatchEvent(new KeyboardEvent(d ? 'keydown' : 'keyup', { code: c, key: c })); window.__tap = async c => { __kd(c, 1); await new Promise(r => setTimeout(r, 90)); __kd(c, 0); }; 1`);
    await sleep(3000); await js('__tap("Enter")'); await sleep(4500); await js('__tap("Enter")');
    for (let i = 0; i < 120 && !await js('!!(view.cur && view.cur.cam)'); i++) await sleep(250);
    const racing = await js('!!(view.cur && view.cur.cam)');
    log('racing', racing);
    await js('window.__kd("ArrowUp", 1), 1'); await sleep(3000);
    // how it runs: frames a second over 3 s, the GPU's state and renderer (a slow app is a software-drawn one)
    win.show(); win.focus(); await sleep(1000);
    log('game frames a second', await js('new Promise(r => { const I = new Int32Array(scene), a = Atomics.load(I, 1); setTimeout(() => r(Math.round((Atomics.load(I, 1) - a) / 3)), 3000); })'));
    log('fps', await js('new Promise(r => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 3000) requestAnimationFrame(f); else r(Math.round(n / 3)); }; requestAnimationFrame(f); })'));
    log('gpu', JSON.stringify(app.getGPUFeatureStatus()));
    log('renderer', await js('(() => { const g = document.createElement("canvas").getContext("webgl2"); const d = g && g.getExtension("WEBGL_debug_renderer_info"); return d ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : "none"; })()'));
    // F: fullscreen, as on the website (a real key press: the page's fullscreen request needs one)
    win.show(); win.focus();
    for (const type of ['keyDown', 'char', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode: 'F' });
    await sleep(1500);
    log('fullscreen', await js('!!document.fullscreenElement'), win.isFullScreen());
    for (const type of ['keyDown', 'char', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode: 'F' });
    await sleep(1500);
    log('fullscreen after a second F', await js('!!document.fullscreenElement'), win.isFullScreen());
    const img = await win.webContents.capturePage();
    const out = path.join(app.getPath('temp'), 'stunts-selftest.png'); fs.writeFileSync(out, img.toPNG()); log('screenshot', out);
    app.exit(racing ? 0 : 1);
  } catch (e) { fail(e.stack || e); }
}

app.whenReady().then(() => { serve(); open(); });
app.on('window-all-closed', () => app.quit());
