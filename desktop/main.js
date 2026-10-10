// Stunts HD as a desktop app: the website's own build (dist/, from stunts/tools/site.py) served to a window under
// app://stunts/ with the headers the site sends (the game's memory is shared with its worker, which needs the page
// cross-origin isolated). Nothing of the game is in the app: the welcome screen asks for your copy, as on the site,
// and here can also open your Stunts folder (or zip) with the system's own dialog.
//   npm start                   run it (dist/ built first: python3 stunts/tools/site.py)
//   npm run selftest -- <dir>   open the game from <dir> without the dialog, start a race, save a screenshot, quit
'use strict';
const { app, BrowserWindow, protocol, ipcMain, dialog, shell } = require('electron');
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

function serve() {
  protocol.handle('app', async req => {
    const u = new URL(req.url);
    let p = decodeURIComponent(u.pathname);
    if (p.endsWith('/')) p += 'index.html';
    const f = path.normalize(path.join(SITE, p));
    if (!f.startsWith(SITE + path.sep) || !fs.existsSync(f) || !fs.statSync(f).isFile()) return new Response('Not found', { status: 404 });
    return new Response(fs.readFileSync(f), { headers: Object.assign({ 'Content-Type': TYPES[path.extname(f).toLowerCase()] || 'application/octet-stream' }, ISOLATED) });
  });
}

function open() {
  const win = new BrowserWindow({
    width: 1280, height: 800, minWidth: 640, minHeight: 400, backgroundColor: '#04061a', title: 'Stunts HD', show: !selftest,
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  // links out (YouTube, Buy Me a Coffee, the other ports) open in the browser, not in the game's window
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('app://')) { e.preventDefault(); shell.openExternal(url); } });
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
    log('tv', await js('(v => JSON.stringify({ ready: v.readyState, t: +v.currentTime.toFixed(2), paused: v.paused, err: v.error && v.error.code, w: v.videoWidth }))(document.getElementById("su-tv"))'));
    if (!await js('!!document.getElementById("su-open")')) return fail('no Open your Stunts folder button');
    await js('document.getElementById("su-open").click()');
    for (let i = 0; i < 60 && !await js('!!document.querySelector("#su-status .ok")'); i++) await sleep(500);
    log('status', await js('document.getElementById("su-status").innerText'));
    if (!await js('!!document.querySelector("#su-status .ok")')) return fail('the game was not taken');
    await js('document.getElementById("su-start").click()');
    for (let i = 0; i < 60 && !await js('typeof view !== "undefined" && typeof mem !== "undefined"'); i++) await sleep(500);
    await js(`window.__kd = (c, d) => dispatchEvent(new KeyboardEvent(d ? 'keydown' : 'keyup', { code: c, key: c })); window.__tap = async c => { __kd(c, 1); await new Promise(r => setTimeout(r, 90)); __kd(c, 0); }; 1`);
    await sleep(3000); await js('__tap("Enter")'); await sleep(4500); await js('__tap("Enter")');
    for (let i = 0; i < 120 && !await js('!!(view.cur && view.cur.cam)'); i++) await sleep(250);
    const racing = await js('!!(view.cur && view.cur.cam)');
    log('racing', racing);
    await js('window.__kd("ArrowUp", 1), 1'); await sleep(3000);
    const img = await win.webContents.capturePage();
    const out = path.join(app.getPath('temp'), 'stunts-selftest.png'); fs.writeFileSync(out, img.toPNG()); log('screenshot', out);
    app.exit(racing ? 0 : 1);
  } catch (e) { fail(e.stack || e); }
}

app.whenReady().then(() => { serve(); open(); });
app.on('window-all-closed', () => app.quit());
