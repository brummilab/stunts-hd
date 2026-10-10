// Your copy of the game: the welcome screen, reading a stunts.zip (or the files themselves) in the browser,
// keeping the files in this browser (IndexedDB), and handing them to the game. Nothing leaves the computer.
//   StuntsSetup.load()          -> the stored files ({ NAME: Uint8Array }) or null
//   StuntsSetup.show(onReady, note, check, ready)   the welcome screen; onReady(files) when Start game is pressed, once a
//                                     good set is in (ready: one kept from last time, in from the start) (check(files):
//                               a promise, rejected with a message for the player when the set cannot run)
'use strict';
(function (root) {
  // files the game cannot start without; the rest are listed if missing but do not stop it
  // (all of Stunts 1.1's own files but the other sound cards' drivers (MT-32, PC speaker, Tandy) and the sample replay)
  const NEED = ['AD15.DRV', 'ADENG1.VCE', 'ADSKIDMS.VCE', 'ALPINE.PVS', 'CARANSX.RES', 'CARAUDI.RES', 'CARCOUN.RES', 'CARFGTO.RES', 'CARJAGU.RES', 'CARLANC.RES', 'CARLM02.RES', 'CARP962.RES', 'CARPC04.RES', 'CARPMIN.RES', 'CARVETT.RES', 'CITY.PVS', 'COUNTRY.PVS', 'CRED.RES', 'DEFAULT.TRK', 'DESERT.PVS', 'FONTDEF.FNT', 'FONTLED.FNT', 'FONTN.FNT', 'GAME.PRE', 'GAME1.P3S', 'GAME2.P3S', 'GEENG.SFX', 'MAIN.RES', 'MISC.PRE', 'OPP1.PRE', 'OPP1LOSE.PVS', 'OPP1WIN.PVS', 'OPP2.PRE', 'OPP2LOSE.PVS', 'OPP2WIN.PVS', 'OPP3.PRE', 'OPP3LOSE.PVS', 'OPP3WIN.PVS', 'OPP4.PRE', 'OPP4LOSE.PVS', 'OPP4WIN.PVS', 'OPP5.PRE', 'OPP5LOSE.PVS', 'OPP5WIN.PVS', 'OPP6.PRE', 'OPP6LOSE.PVS', 'OPP6WIN.PVS', 'SDCRED.PES', 'SDCSEL.PVS', 'SDGAME.PVS', 'SDGAME2.PVS', 'SDMAIN.PVS', 'SDMSEL.PVS', 'SDOSEL.PVS', 'SDTEDIT.PES', 'SDTITL.PVS', 'SKIDOVER.KMS', 'SKIDSLCT.KMS', 'SKIDTITL.KMS', 'SKIDVICT.KMS', 'STANSX.P3S', 'STAUDI.P3S', 'STCOUN.P3S', 'STDAANSX.PVS', 'STDAAUDI.PVS', 'STDACOUN.PVS', 'STDAFGTO.PVS', 'STDAJAGU.PVS', 'STDALANC.PVS', 'STDALM02.PVS', 'STDAP962.PVS', 'STDAPC04.PVS', 'STDAPMIN.PVS', 'STDAVETT.PVS', 'STDBANSX.PVS', 'STDBAUDI.PVS', 'STDBCOUN.PVS', 'STDBFGTO.PVS', 'STDBJAGU.PVS', 'STDBLANC.PVS', 'STDBLM02.PVS', 'STDBP962.PVS', 'STDBPC04.PVS', 'STDBPMIN.PVS', 'STDBVETT.PVS', 'STFGTO.P3S', 'STJAGU.P3S', 'STLANC.P3S', 'STLM02.P3S', 'STP962.P3S', 'STPC04.P3S', 'STPMIN.P3S', 'STVETT.P3S', 'TEDIT.PRE', 'TITLE.P3S', 'TROPICAL.PVS'];
  // and the program: GAME.EXE, or the parts the game's installer builds it from (the MCGA build)
  const PROGRAM = ['EGA.CMN', 'MCGA.HDR', 'MCGA.DIF', 'MCGA.COD'];
  const COD_11 = 48899;   // (Stunts 1.1's MCGA.COD, dated 13 March 1991)
  const missing = files => NEED.filter(n => !files[n]).concat(files['GAME.EXE'] || PROGRAM.every(n => files[n]) ? [] : PROGRAM.filter(n => !files[n]));
  const KEEP = /\.(RES|P3S|3SH|PVS|VSH|XVS|PES|ESH|PRE|FNT|TRK|RPL|DRV|VCE|SFX|KMS|PLB|TD|HIG)$|^GAME\.EXE$|^EGA\.CMN$|^MCGA\.(HDR|DIF|COD)$/;   // (what the game reads, and its program; the rest is left out. 3SH, VSH, XVS, ESH: the unpacked forms the game also takes, as added cars often come: without them it asked for the disk again and again)

  // ---- stored files (IndexedDB: survives reloads, stays on this computer) ----
  const db = () => new Promise((res, rej) => { const r = indexedDB.open('stunts-recomp', 1); r.onupgradeneeded = () => r.result.createObjectStore('files'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  async function load() {
    try { const d = await db(); return await new Promise(res => { const r = d.transaction('files').objectStore('files').get('game'); r.onsuccess = () => res(r.result || null); r.onerror = () => res(null); }); }
    catch (_) { return null; }
  }
  async function store(files) { const d = await db(); await new Promise((res, rej) => { const t = d.transaction('files', 'readwrite'); t.objectStore('files').put(files, 'game'); t.oncomplete = res; t.onerror = () => rej(t.error); }); }
  async function forget() { const d = await db(); await new Promise(res => { const t = d.transaction('files', 'readwrite'); t.objectStore('files').delete('game'); t.oncomplete = res; t.onerror = res; }); }

  // ---- a zip, read in the browser (stored and deflated entries; the browser's own decompressor) ----
  async function unzip(buf) {
    const u = new Uint8Array(buf), v = new DataView(buf), out = {};
    let e = u.length - 22;
    while (e >= 0 && v.getUint32(e, true) !== 0x06054b50) e--;
    if (e < 0) throw new Error('This does not look like a zip file.');
    let p = v.getUint32(e + 16, true);
    const n = v.getUint16(e + 10, true);
    for (let i = 0; i < n; i++) {
      if (v.getUint32(p, true) !== 0x02014b50) break;
      const method = v.getUint16(p + 10, true), csize = v.getUint32(p + 20, true), nl = v.getUint16(p + 28, true), xl = v.getUint16(p + 30, true), cl = v.getUint16(p + 32, true), lo = v.getUint32(p + 42, true);
      const name = new TextDecoder().decode(u.subarray(p + 46, p + 46 + nl));
      p += 46 + nl + xl + cl;
      if (name.endsWith('/') || /(^|\/)__MACOSX\//.test(name) || /(^|\/)\._/.test(name)) continue;
      const start = lo + 30 + v.getUint16(lo + 26, true) + v.getUint16(lo + 28, true), data = u.subarray(start, start + csize);
      let bytes;
      if (method === 0) bytes = data.slice();
      else if (method === 8) bytes = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
      else continue;
      out[name] = bytes;
    }
    return out;
  }
  // any folder layout: file names only, upper case (DOS); zips inside the zip are opened too
  async function collect(list) {
    const files = {}; collect.names = [];
    const add = async (name, bytes) => {
      const base = name.split(/[\\/]/).pop().toUpperCase(); collect.names.push(name.toUpperCase());
      if (base.endsWith('.ZIP')) {   // (a zip inside that can't be read is passed over: the rest may be the whole game)
        let z = null; try { z = await unzip(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length)); } catch (_) {}
        if (z) for (const [k, b] of Object.entries(z)) await add(k, b);
        return;
      }
      if (KEEP.test(base) && base.length <= 12) files[base] = bytes;
    };
    for (const f of list) await add(f.name, new Uint8Array(await f.arrayBuffer()));
    return files;
  }

  // ---- the welcome screen: the trailer on a widescreen TV, the title, your copy in, and the details behind links
  // (laid out like the VF1 recomp's page). Colours from the game's menu: its hazard stripes and road signs. ----
  const SIGN = {   // the main menu's four road signs, as small icons
    car: '<svg class="sg" viewBox="0 0 20 20"><circle cx="10" cy="10" r="8.5" fill="#1d3fd8"/></svg>',
    track: '<svg class="sg" viewBox="0 0 20 20"><path d="M1.6 3h16.8L10 18z" fill="#f59a1c"/></svg>',
    opp: '<svg class="sg" viewBox="0 0 20 20"><path d="M6.5 1.5h7l5 5v7l-5 5h-7l-5-5v-7z" fill="#d81818"/></svg>',
    opt: '<svg class="sg" viewBox="0 0 20 20"><rect x="2" y="2" width="16" height="16" fill="#2f8f3a"/></svg>',
    sup: '<svg class="sg" viewBox="0 0 20 20"><path d="M10 1l9 9-9 9-9-9z" fill="#e8c21a"/></svg>',
    src: '<svg class="sg" viewBox="0 0 20 20"><rect x="1.5" y="1.5" width="17" height="17" fill="#2b2b2b"/><path d="M8 6.5 4.5 10 8 13.5M12 6.5l3.5 3.5-3.5 3.5" fill="none" stroke="#fff" stroke-width="1.8"/></svg>',   // (a dark sign with code brackets: the source on GitHub)
    play: '<svg class="sg" viewBox="0 0 20 20"><rect x="1.5" y="1.5" width="17" height="17" fill="#1d3fd8"/><path d="M7.5 5.5l6.5 4.5-6.5 4.5z" fill="#fff"/></svg>',   // (an information sign: the trailer)
    log: '<svg class="sg" viewBox="0 0 20 20"><rect x="2" y="3" width="16" height="14" fill="#ececec"/><path d="M5 7.5h10M5 12.5h7" stroke="#333" stroke-width="2"/></svg>',   // (a notice board: the changelog)
    all: '<svg class="sg" viewBox="0 0 20 20"><rect x="2" y="2" width="7" height="7" fill="#1d3fd8"/><rect x="11" y="2" width="7" height="7" fill="#f59a1c"/><rect x="2" y="11" width="7" height="7" fill="#2f8f3a"/><rect x="11" y="11" width="7" height="7" fill="#d81818"/></svg>'
  };
  // the More ports menu at the top right: this port and the others. The others' icons are inline: this page is
  // cross-origin isolated, so it can't show images from another site.
  const PORTS = [
    { name: 'Stunts HD', about: '1990 DOS racer, in your browser', icon: 'media/favicon.png' },
    { name: 'Virtua Fighter', about: '1993 arcade fighter, for Windows, Mac and Steam Deck', url: 'https://vf1-recomp.pages.dev/',
      icon: 'data:image/webp;base64,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' }
  ];
  const portRow = p => p.url
    ? `<li><a href="${p.url}"><img src="${p.icon}" alt="" width="40" height="40"><span><b>${p.name}</b>${p.about}</span></a></li>`
    : `<li><div class="prow"><img src="${p.icon}" alt="" width="40" height="40"><span><b>${p.name}</b>${p.about}</span></div></li>`;
  // a skyline behind the TV, drawn for this page in the menu's low-poly style: far peaks with snow, near hills
  const FAR = '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="160" viewBox="0 0 1200 160"><path d="M0 160 L0 48 106 29 128 88 148 72 173 25 178 90 206 33 222 46 338 92 469 25 693 91 778 92 838 68 886 24 918 46 1069 23 1127 89 1200 48 L1200 160Z" fill="#16224a"/><path d="M106 29 L76 34 L109 33 L112 46Z" fill="#2c3d72"/><path d="M173 25 L166 38 L174 36 L174 43Z" fill="#2c3d72"/><path d="M206 33 L198 49 L208 46 L210 37Z" fill="#2c3d72"/><path d="M469 25 L432 44 L500 40 L532 43Z" fill="#2c3d72"/><path d="M886 24 L873 36 L890 34 L895 30Z" fill="#2c3d72"/><path d="M1069 23 L1027 29 L1077 28 L1085 41Z" fill="#2c3d72"/></svg>';
  const NEAR = '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="160" viewBox="0 0 1200 160"><path d="M0 160 L0 115 241 107 271 121 325 126 400 106 414 122 623 105 661 123 888 110 1137 119 1200 115 L1200 160Z" fill="#0d1631"/></svg>';
  const svg = t => `url("data:image/svg+xml,${encodeURIComponent(t)}")`;
  const CSS = `
  @font-face { font-family: "Press Start 2P"; src: url(fonts/press-start-2p.woff2) format("woff2"); font-display: swap; }
  #setup { --ground: #070a16; --line: #2a3150; --ink: #f1efe8; --muted: #a9adc2; --dim: #747a96; --yel: #fff721; --yel2: #fffa6b;
    --px: "Press Start 2P", ui-monospace, Menlo, monospace;
    position: fixed; inset: 0; z-index: 10; overflow: auto; overflow-x: hidden; cursor: auto; color: var(--ink); background: var(--ground);
    font: 17px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; color-scheme: dark; }
  #setup *, #setup *::before { box-sizing: border-box; }
  #setup .sky { position: fixed; inset: 0; pointer-events: none;
    background: radial-gradient(ellipse 80% 55% at 50% 34%, rgba(60,140,252,.17), transparent 70%), linear-gradient(#0a1230, var(--ground) 60%); }
  #setup main { position: relative; min-height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center;
    text-align: center; padding: 24px 16px; }
  @keyframes su-rise { from { opacity: 0; transform: translateY(22px); } to { opacity: 1; transform: none; } }
  @keyframes su-fade { from { opacity: 0; } to { opacity: 1; } }

  /* the trailer playing, its corners rounded; hills drift past behind it */
  #setup .tv { position: relative; margin: clamp(18px, 4.5vh, 48px) 0; width: min(1000px, 100%, max(300px, (100vh - 540px) * 1.78, 30vw)); animation: su-rise .9s cubic-bezier(.2,.7,.3,1) .2s backwards; }
  #setup .tv { isolation: isolate; }
  #setup .hills { position: absolute; z-index: -1; left: 50%; top: 40%; width: 100vw; height: 160px; transform: translateX(-50%); pointer-events: none; opacity: .6;
    -webkit-mask-image: linear-gradient(90deg, transparent, #000 25%, #000 75%, transparent); mask-image: linear-gradient(90deg, transparent, #000 25%, #000 75%, transparent); }
  #setup .hills i { position: absolute; inset: 0; background-repeat: repeat-x; background-position: 0 100%; animation: su-pan 100s linear infinite; }
  #setup .hills .far { background-image: ${svg(FAR)}; opacity: .9; }
  #setup .hills .near { background-image: ${svg(NEAR)}; animation-duration: 50s; }
  #setup .hills::after { content: ""; position: absolute; left: 0; right: 0; top: 100%; height: 240px; background: linear-gradient(#0d1631, transparent); }
  @keyframes su-pan { to { background-position: -1200px 100%; } }
  #setup .set { position: relative; }
  #setup .scr { position: relative; aspect-ratio: 16 / 9; overflow: hidden; background: #000; border-radius: 14px; }
  #setup .scr video, #setup .scr img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; display: block; }
  #setup #su-tvbtn { position: absolute; inset: 0; z-index: 2; border: 0; padding: 0; background: transparent; cursor: pointer; }
  #setup .idle { position: absolute; inset: 0; display: grid; place-items: center; font: 400 clamp(14px, 3vw, 26px) var(--px); color: var(--yel);
    background: #000; }
  #setup .drophint { position: absolute; inset: 0; display: none; place-items: center; z-index: 2; background: rgba(0,0,0,.78);
    border: clamp(8px, 1.6vw, 14px) solid; border-image: repeating-linear-gradient(-45deg, var(--yel) 0 14px, #111 14px 28px) 14;
    font: 400 clamp(12px, 2.4vw, 20px)/1.8 var(--px); color: #fff; }
  #setup.over .drophint { display: grid; }

  #setup h1 { position: relative; margin: 0; line-height: 0; animation: su-rise .7s cubic-bezier(.2,.7,.3,1) .1s backwards; }
  #setup h1 img { display: block; width: clamp(240px, 42vw, 460px); height: auto; filter: drop-shadow(3px 4px 0 rgba(0,0,0,.55)); }
  /* a little HD tucked under the logo's U, in the game's letters and the logo's yellow, as on the trailer's end frame
     (logo.webp is 1000x244: the notch under the U's right side, against the N's leg, at x 475, y 184; sized and placed
     by the logo's own width) */
  #setup h1 .hd { position: absolute; left: 47.5%; top: 75.4%; font: 400 calc(clamp(240px, 42vw, 460px) * .04)/1 var(--px);
    color: #f2f714; text-shadow: 3px 4px 0 rgba(0,0,0,.55); white-space: nowrap; }
  #setup .aka { margin: 8px 0 0; font-size: .74rem; letter-spacing: .14em; text-transform: uppercase; color: var(--dim); animation: su-fade 1s ease .2s backwards; }
  #setup .ver { margin: 10px 0 0; font-size: .86rem; font-weight: 600; color: var(--ink); animation: su-fade 1s ease .3s backwards; }
  #setup .cta { margin-top: 0; display: flex; gap: .7rem; justify-content: center; flex-wrap: wrap; animation: su-rise .7s cubic-bezier(.2,.7,.3,1) .5s backwards; }
  #setup .btn { display: inline-flex; align-items: center; gap: .6rem; cursor: pointer; border: 0; border-radius: 999px; padding: .8rem 1.5rem;
    font: 700 1.02rem system-ui, sans-serif; color: #111; background: var(--yel); text-decoration: none; transition: background .18s, box-shadow .18s; }
  #setup .btn .ico { width: 1.1em; height: 1.1em; flex: none; margin-left: -.2rem; }
  #setup .btn:hover { background: var(--yel2); }
  #setup .btn:focus-visible, #setup .lnk:focus-visible { outline: 2px solid var(--yel); outline-offset: 3px; }
  #setup .cta { flex-direction: column; align-items: center; }
  #setup .cta [hidden] { display: none; }
  #setup .cta .again { cursor: pointer; font-size: .82rem; color: var(--dim); text-decoration: underline; text-underline-offset: 3px; }
  #setup .cta .again:hover { color: var(--ink); }
  #setup .status { margin-top: .9rem; max-width: 36em; font-size: .92rem; color: var(--muted); }
  #setup .status:empty { display: none; }
  #setup .status .ok { color: #7fe39a; } #setup .status .bad { color: #ff8a7a; }
  #setup .status .btn { margin-top: .9rem; }

  #setup .more { position: relative; z-index: 3; margin-top: 1.5rem; display: flex; justify-content: center; flex-wrap: wrap; gap: .15rem 1rem;
    animation: su-rise .7s cubic-bezier(.2,.7,.3,1) .6s backwards; }
  #setup .info { position: relative; }
  #setup .info::before { content: ""; position: absolute; left: 0; right: 0; bottom: 100%; height: 12px; }
  #setup .lnk { display: inline-flex; align-items: center; gap: .45rem; padding: .3rem .35rem; border: 0; background: transparent; cursor: pointer;
    font: 600 .9rem system-ui, sans-serif; color: var(--muted); text-decoration: underline; text-decoration-color: var(--line);
    text-underline-offset: 4px; text-decoration-thickness: 1.5px; transition: color .18s, text-decoration-color .18s; }
  #setup .lnk .sg { width: 1.05em; height: 1.05em; flex: none; }
  #setup .lnk:hover, #setup .info.open .lnk { color: #fff; text-decoration-color: var(--yel); }
  /* Watch: the trailer with sound, from YouTube, over the page */
  #su-vid { position: fixed; inset: 0; z-index: 2147483000; display: flex; align-items: center; justify-content: center; padding: 16px;
    background: rgba(2,3,12,.88); -webkit-backdrop-filter: blur(4px); backdrop-filter: blur(4px); cursor: pointer; }
  #su-vid .yt { position: relative; width: min(1700px, 100%, calc((100vh - 110px) * 16 / 9)); aspect-ratio: 16 / 9; border-radius: 10px; overflow: hidden;
    background: #000; box-shadow: 0 30px 80px rgba(0,0,0,.7); cursor: auto; }
  #su-vid iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; }
  #su-vid .x { position: absolute; top: 14px; right: 16px; width: 36px; height: 36px; border-radius: 50%; border: 0; cursor: pointer;
    background: rgba(255,255,255,.1); color: #fff; font: 600 1.2rem/36px system-ui, sans-serif; }
  #su-vid .x:hover { background: rgba(255,255,255,.2); }
  #setup .pop { position: absolute; bottom: calc(100% + 10px); left: 50%; width: min(380px, calc(100vw - 32px)); max-height: min(72vh, 560px);
    overflow-y: auto; overscroll-behavior: contain; padding: 0 0 1rem; text-align: left; background: #0e1226; border-radius: 4px;
    box-shadow: 0 24px 60px rgba(0,0,0,.7), inset 0 0 0 1px rgba(255,255,255,.08);
    opacity: 0; visibility: hidden; transform: translateX(-50%) translateY(6px); transition: opacity .18s, transform .18s, visibility .18s; }
  #setup .pop.wide { width: min(440px, calc(100vw - 32px)); }
  #setup .info.open .pop { opacity: 1; visibility: visible; transform: translateX(-50%); }
  @media (hover: hover) { #setup .info:hover .pop { opacity: 1; visibility: visible; transform: translateX(-50%); } }
  /* headings as the trailer's captions: white game-style letters in a black box, a yellow line under */
  #setup .pop h2 { margin: 0 0 .8rem; padding: .85rem 1.1rem .75rem; background: #000; font: 400 .74rem/1.5 var(--px); color: #fff; letter-spacing: .02em; }
  #setup .pop h2 small { display: block; margin-top: .45rem; font-size: .5rem; color: var(--yel); }
  #setup .pop h3 { margin: 1rem 1.1rem .35rem; font: 400 .55rem var(--px); color: var(--yel); }
  #setup .pop p, #setup .pop ul, #setup .pop ol, #setup .pop .keys { margin: 0 1.1rem; font-size: .86rem; line-height: 1.5; color: var(--muted); }
  #setup .pop p + p { margin-top: .5rem; }
  #setup .pop b { color: var(--ink); }
  #setup .pop ul, #setup .pop ol { list-style: none; padding: 0; }
  #setup .pop li { position: relative; padding-left: 1rem; margin-top: .45rem; }
  #setup .pop li:first-child { margin-top: 0; }
  #setup .pop ul li::before { content: ""; position: absolute; left: 0; top: .55em; width: 6px; height: 6px; background: var(--yel); }
  #setup .pop ol { counter-reset: n; }
  #setup .pop ol li { padding-left: 1.4rem; counter-increment: n; }
  #setup .pop ol li::before { content: counter(n); position: absolute; left: 0; top: 0; font: 400 .6rem/calc(.86rem * 1.5) var(--px); color: var(--yel); }
  #setup .pop code { font: 500 .78rem ui-monospace, Menlo, monospace; color: var(--ink); background: #05070f; border-radius: 3px; padding: .05rem .35rem; }
  #setup .keys { display: grid; grid-template-columns: max-content 1fr; gap: .4rem .9rem; align-items: baseline; }
  #setup kbd { font: 700 .72rem ui-monospace, Menlo, monospace; background: #e9e4d6; color: #111; border-radius: 3px; padding: .05rem .4rem;
    box-shadow: 0 2px 0 #8c877a; white-space: nowrap; }
  #setup .note { max-width: 42em; margin-top: 1.4rem; font-size: .72rem; line-height: 1.55; color: var(--dim); text-wrap: pretty; animation: su-fade 1s ease 1s backwards; }
  #setup .note a { color: var(--muted); }
  #setup input[type=file] { display: none; }
  @media (max-width: 520px) { #setup { font-size: 16px; } #setup .lnk { font-size: .84rem; padding-inline: .15rem; } }

  /* More ports: a pill at the top right whose panel drops down, like the links' panels below */
  #setup .ports { position: absolute; top: 14px; right: 16px; z-index: 4; text-align: left; animation: su-fade 1s ease .4s backwards; }
  #setup .ports .lnk { padding: .4rem .75rem .4rem .6rem; border-radius: 999px; text-decoration: none; background: rgba(14,18,38,.65);
    box-shadow: inset 0 0 0 1px var(--line); }
  #setup .ports .lnk:hover, #setup .ports .info.open .lnk { box-shadow: inset 0 0 0 1px var(--yel); }
  #setup .ports .chev { width: .7em; height: .7em; flex: none; transition: transform .18s; }
  #setup .ports .info.open .chev { transform: rotate(180deg); }
  #setup .ports .info::before { bottom: auto; top: 100%; }
  #setup .ports .pop { top: calc(100% + 10px); bottom: auto; left: auto; right: 0; width: min(340px, calc(100vw - 32px)); padding: .45rem 0; transform: translateY(-6px); }
  #setup .ports .info.open .pop { transform: none; }
  @media (hover: hover) { #setup .ports .info:hover .pop { transform: none; } #setup .ports .info:hover .chev { transform: rotate(180deg); } }
  /* a phone: the links' panels as on the VF1 page, across the screen 16px in from each side and centred top to bottom
     (above its link, a panel off to one side ran off the screen's edge); the More ports menu still drops from its corner */
  @media (max-width: 640px) {
    #setup .more .pop, #setup .more .pop.wide { position: fixed; left: 16px; right: 16px; width: auto; top: 50%; bottom: auto; max-height: 80vh; transform: translateY(calc(-50% + 6px)); }
    #setup .more .info.open .pop { transform: translateY(-50%); }
    /* (with a mouse too, only a click opens one: a panel opened by hovering covered the links, and took the click) */
    #setup .more .info:not(.open):hover .pop { opacity: 0; visibility: hidden; }
  }
  #setup .pop .plist { margin: 0; }
  #setup .pop .plist li { padding: 0; margin: 0; }
  #setup .pop .plist li::before { display: none; }
  #setup .plist a, #setup .plist .prow { display: flex; align-items: center; gap: .8rem; padding: .55rem 1.1rem; color: var(--muted);
    text-decoration: none; font-size: .84rem; line-height: 1.35; }
  #setup .plist a:hover, #setup .plist a:focus-visible { background: rgba(255,255,255,.06); outline: none; }
  #setup .plist img { width: 40px; height: 40px; flex: none; border-radius: 9px; }
  #setup .plist b { display: block; font-size: .95rem; }
  @media (max-width: 520px) { #setup main { padding-top: 64px; } }
`;
  const HTML = `
  <div class="sky"></div>
  <main>
    <nav class="ports" aria-label="More ports"><span class="info"><button class="lnk" aria-expanded="false">${SIGN.all}More ports<svg class="chev" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      <div class="pop">
        <ul class="plist">${PORTS.map(portRow).join('')}</ul>
      </div></span></nav>
    <h1><img src="logo.webp" alt="STUNTS HD" width="1000" height="245"><span class="hd" aria-hidden="true">HD</span></h1>
    <p class="aka">Also known as 4D Sports Driving</p>
    <p class="ver">The 1990 original, recompiled for your browser in <b style="color: var(--yel)">HD widescreen</b></p>
    <div class="tv">
      <div class="hills"><i class="far"></i><i class="near"></i></div>
      <div class="set">
        <div class="scr" id="su-scr">
          <div class="idle">STUNTS HD</div>
          <video id="su-tv" poster="media/poster.jpg" muted loop playsinline autoplay preload="auto"></video><button id="su-tvbtn" aria-label="Watch the trailer with sound"></button>
          <div class="drophint">DROP YOUR<br>STUNTS.ZIP</div>
        </div>
      </div>
    </div>
    <div class="cta">
      <label class="btn" for="su-file"><svg class="ico" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 13V3M5.5 7.5 10 3l4.5 4.5M3 13v3.5h14V13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>Upload your game files</label>
      <button class="btn" id="su-open" hidden><svg class="ico" viewBox="0 0 20 20" aria-hidden="true"><path d="M2.5 5.5v10h15v-8H9.5l-2-2z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>Open your Stunts folder</button>
      <button class="btn" id="su-start" hidden><svg class="ico" viewBox="0 0 20 20" aria-hidden="true"><path d="M6 3.5v13l10.5-6.5z" fill="currentColor"/></svg>Start game</button>
      <label class="again" for="su-file" hidden>or use a different copy</label>
    </div>
    <input type="file" id="su-file" accept=".zip,application/zip" multiple>
    <div class="status" id="su-status"></div>

    <nav class="more" aria-label="More about it">
      <span class="info"><a class="lnk" id="su-watch" href="https://youtu.be/WifwNFpG96o" target="_blank" rel="noopener">${SIGN.play}Watch</a></span>
      <span class="info"><button class="lnk" aria-expanded="false">${SIGN.car}Features</button>
        <div class="pop">
          <h2>What's new<small>OVER THE 1990 ORIGINAL</small></h2>
          <ul>
            <li><b>The game's own code,</b> recompiled from your copy in this browser: the same physics, cars and opponents.</li>
            <li><b>HD 3D in widescreen,</b> smooth at any refresh rate.</li>
            <li><b>OG mode:</b> press <kbd>H</kbd> for the 1990 look, at any time.</li>
            <li><b>Locked chase cam,</b> now the default.</li>
            <li><b>Cars in HD 3D,</b> crumpling when they crash, and 3D explosions.</li>
            <li><b>Unlimited draw distance,</b> car shadows, tyre marks, water reflections and ripples.</li>
            <li><b>Ghost car:</b> race your best lap, kept for every track.</li>
            <li><b>Share tracks:</b> Import/Export in the track menu, as a short code or a <code>.TRK</code> file.</li>
            <li><b>3D track preview:</b> drag to turn it, scroll to zoom.</li>
            <li><b>Instant restart</b> with <kbd>R</kbd>, and your camera kept from race to race.</li>
            <li><b>A cleaner HUD</b> with the track's record, and the original AdLib music and sound.</li>
            <li><b>Your own tracks:</b> drop <code>.TRK</code> files on the game at any time.</li>
            <li><b>Keyboard or gamepad.</b></li>
          </ul>
          <h3>ORIGINAL GAME FIXES</h3>
          <ul>
            <li><b>The bump bug:</b> touching the other car could leave yours pulling left for the rest of the race (a rounding slip in the 1990 code). Now it straightens out.</li>
            <li><b>Tunnel roofs</b> show from outside too; the original drew them only from inside.</li>
            <li><b>No demo</b> starting by itself while you sit in the menus.</li>
          </ul>
        </div></span>
      <span class="info"><button class="lnk" aria-expanded="false">${SIGN.track}How to play</button>
        <div class="pop">
          <h2>You need<small>STUNTS 1.1, IN A ZIP</small></h2>
          <ol>
            <li>Find your Stunts folder: the one with <code>STUNTS.EXE</code>, <code>GAME1.P3S</code>, <code>MAIN.RES</code> and friends (Stunts 1.1).</li>
            <li><b>Which copy?</b> Stunts 1.1: its <code>MCGA.COD</code> is ${COD_11.toLocaleString('en')} bytes, dated 13 March 1991. 4D Sports Driving (the European release) and other versions don't run yet.</li>
            <li><b>No copy to hand?</b> The Stunts community still races it every year: look up ZakStunts or the Stunts Wiki.</li>
            <li>Already have it as a zip? Use that as it is. If not, zip the whole folder. Any layout works: files in subfolders, or loose at the top.</li>
            <li><b>Your tracks too:</b> any <code>.TRK</code> tracks (and <code>.RPL</code> replays) in the zip show up in the game's track menu.</li>
          </ol>
          <h3>STAYS ON YOUR COMPUTER</h3>
          <p>Your files are read here and kept in this browser for next time, never sent anywhere. Tracks you build and replays you save are kept here too.</p>
        </div></span>
      <span class="info"><button class="lnk" aria-expanded="false">${SIGN.opt}Keys</button>
        <div class="pop wide">
          <h2>Keys<small>A GAMEPAD WORKS TOO</small></h2>
          <div class="keys">
            <span><kbd>↑</kbd> <kbd>↓</kbd> <kbd>←</kbd> <kbd>→</kbd></span><span>Accelerate, brake, steer</span>
            <span><kbd>A</kbd> <kbd>Z</kbd></span><span>Gear up, down (manual gearbox)</span>
            <span><kbd>C</kbd></span><span>Change camera: in car, high, chase, TV</span>
            <span><kbd>H</kbd></span><span>HD mode or OG mode</span>
            <span><kbd>G</kbd></span><span>Ghost car on and off (once you have a best lap)</span>
            <span><kbd>D</kbd></span><span>Dashboard on and off</span>
            <span><kbd>R</kbd></span><span>Restart the race</span>
            <span><kbd>Esc</kbd></span><span>Race menu: replays, restart, quit</span>
            <span><kbd>F</kbd></span><span>Fullscreen</span>
          </div>
          <p style="margin-top:.7rem">Gamepad: stick or d-pad to steer, triggers to drive.</p>
        </div></span>
      <span class="info"><button class="lnk" aria-expanded="false">${SIGN.opp}Known issues</button>
        <div class="pop">
          <h2>Known issues<small>BEING WORKED ON</small></h2>
          <ul>
            <li><b>Only Stunts 1.1</b> runs: other versions are turned away for now.</li>
          </ul>
        </div></span>
      <span class="info"><button class="lnk" aria-expanded="false">${SIGN.log}Changelog</button>
        <div class="pop">
          <h2>Changelog<small>WHAT CHANGED, NEWEST FIRST</small></h2>
          <p><b>v1.0</b> &middot; Oct 9 2026</p>
          <ul>
            <li>First release.</li>
          </ul>
        </div></span>
      <span class="info"><a class="lnk" href="https://github.com/mr-finster/stunts-hd" target="_blank" rel="noopener">${SIGN.src}GitHub</a></span>
      <span class="info"><a class="lnk" id="su-support" href="https://buymeacoffee.com/mrfinster" target="_blank" rel="noopener">${SIGN.sup}Support me</a></span>
    </nav>

    <p class="note">A fan-made recompilation of Stunts (Distinctive Software, 1990): the game's own code is translated in your browser from the copy you bring, and the PC around it is rebuilt. No game files are included: you need your own copy. Stunts © 1990 Distinctive Software / Broderbund. Not affiliated with or endorsed by them.</p>
  </main>
`;

  function show(onReady, note, check, ready) {
    const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    const el = document.createElement('div'); el.id = 'setup'; el.innerHTML = HTML; document.body.appendChild(el);
    const status = el.querySelector('#su-status'), input = el.querySelector('#su-file'), tv = el.querySelector('#su-tv');
    tv.onerror = () => tv.remove();   // (no trailer next to the page: the title shows)
    // the trailer fetched whole and played from memory: the host answers no byte ranges, and without them the
    // player can't skip back or forward
    let tvUrl = '';
    fetch('media/trailer.mp4').then(r => r.ok ? r.blob() : Promise.reject())
      .then(b => { if (!tv.isConnected) return; tv.src = tvUrl = URL.createObjectURL(b); tv.play().catch(() => {}); }).catch(() => tv.remove());
    const say = h => { status.innerHTML = h; try { status.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (_) {} };   // (the answer in view: on a short window it fell below the fold)
    if (note) say(note);
    let latest = 0;
    // a good set in (from a zip just now, or kept from last time): the big button starts the game; the welcome screen
    // stays up till then (its links, Support me), and a small link loads a different copy
    const start = el.querySelector('#su-start'), up = el.querySelector('.cta label.btn'), again = el.querySelector('.cta .again');
    // (in the desktop app: the system's own dialog for your Stunts folder or zip, in place of the upload button)
    const open = el.querySelector('#su-open'), host = root.stuntsHost;
    if (host) { open.hidden = false; up.hidden = true; open.onclick = async () => { const list = await host.pickGame(); if (list) take(list.map(f => new File([f.data], f.name))); }; again.onclick = e => { e.preventDefault(); open.onclick(); }; }
    const armed = files => {
      up.hidden = true; open.hidden = true; start.hidden = false; again.hidden = false;
      start.onclick = () => { if (closeWatch) closeWatch(); tv.pause(); if (tvUrl) URL.revokeObjectURL(tvUrl); el.remove(); st.remove(); onReady(files); };
    };
    if (ready) armed(ready);
    // (a hint at which copy it was, when the program is not the one this page knows: 4D Sports Driving, the game's
    // European release, has a different program; the size of MCGA.COD tells the versions apart)
    const which = files => {
      const cod = files['MCGA.COD'], size = cod ? cod.length : 0, n = collect.names || [];
      const eu = n.some(k => k.endsWith('.D4D') || /4D[ _-]?SPORTS/.test(k));
      // (the size only when it tells: the same size as 1.1's means a changed copy, and a GAME.EXE alone has none)
      const sz = size && size !== COD_11 ? `: its <code>MCGA.COD</code> is ${COD_11.toLocaleString('en')} bytes, yours is ${size.toLocaleString('en')}` : size ? ': this one looks like it but has been changed' : '';
      return `<br><small>${eu ? 'This looks like <b>4D Sports Driving</b>, the European release: its program is different and does not run here yet. ' : ''}`
        + `You need an original <b>Stunts 1.1</b>${sz}.</small>`;
    };
    async function take(list) {
      if (!list || !list.length) return;
      const me = ++latest;
      say('Reading…');
      let files;
      try { files = await collect([...list]); } catch (err) { if (me === latest) say(`<span class="bad">${/Offset|bounds/.test(err.message) ? 'This zip could not be read (it may be a zip64 or damaged file): try making it again.' : err.message || err}</span>`); return; }
      if (me !== latest) return;   // (a newer pick or drop since)
      const names = Object.keys(files), miss = missing(files);
      const tracks = names.filter(n => n.endsWith('.TRK')).length, replays = names.filter(n => n.endsWith('.RPL')).length;
      if (miss.length) {
        say(`<span class="bad">That doesn't look like the whole game: missing ${miss.slice(0, 6).join(', ')}${miss.length > 6 ? ` and ${miss.length - 6} more` : ''}.</span> Zip the full Stunts 1.1 folder and try again.</span>${collect.names && collect.names.some(k => k.endsWith('.D4D') || /4D[ _-]?SPORTS/.test(k)) ? which(files) : ''}`);
        return;
      }
      if (check) {
        say('Building the game from your copy…');
        try { await check(files); } catch (err) { if (me === latest) say(`<span class="bad">${err.message || err}</span>${which(files)}`); return; }
        if (me !== latest) return;
      }
      try { await store(files); } catch (_) {}
      say(`<span class="ok">✓ Found the game: ${names.length} files, ${tracks} track${tracks === 1 ? '' : 's'}${replays ? `, ${replays} replay${replays === 1 ? '' : 's'}` : ''}.</span>`);
      armed(files); start.focus();
    }
    input.onchange = async () => { await take(input.files); input.value = ''; };
    // a drop anywhere on the page (the TV says where)
    let depth = 0;
    el.addEventListener('dragenter', e => { e.preventDefault(); if (depth++ === 0) el.classList.add('over'); });
    el.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; el.classList.remove('over'); } });
    el.addEventListener('dragover', e => e.preventDefault());
    el.addEventListener('drop', e => { e.preventDefault(); e.stopPropagation(); depth = 0; el.classList.remove('over'); take(e.dataTransfer.files); });
    // the links' panels: open on hover (where there is one) or a click, one at a time
    const infos = [...el.querySelectorAll('.info')];
    const shut = keep => infos.forEach(i => { if (i !== keep) { i.classList.remove('open'); i.firstElementChild.setAttribute('aria-expanded', 'false'); } });
    for (const i of infos) i.firstElementChild.onclick = e => {
      e.stopPropagation(); const o = !i.classList.contains('open'); shut(i);
      i.classList.toggle('open', o); i.firstElementChild.setAttribute('aria-expanded', String(o));
    };
    el.addEventListener('click', e => { if (!e.target.closest('.pop')) shut(); });
    el.addEventListener('keydown', e => { if (e.key === 'Escape') shut(); });
    // Watch: the trailer with sound, from YouTube, over the page, the TV paused meanwhile (a credentialless iframe, as Support
    // me's below; where there's none, the link itself opens YouTube in a tab of its own)
    let closeWatch = null;
    el.querySelector('#su-watch').addEventListener('click', e => {
      shut();   // (a link, not a panel: not left highlighted)
      if (!('credentialless' in HTMLIFrameElement.prototype)) return;
      e.preventDefault();
      if (document.getElementById('su-vid')) return;
      const back = document.createElement('div'); back.id = 'su-vid';
      back.innerHTML = '<div class="yt"></div><button class="x" aria-label="Close">&times;</button>';
      const f = document.createElement('iframe');
      f.credentialless = true;                                // (before its src)
      f.title = 'Stunts HD trailer'; f.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen'; f.allowFullscreen = true;
      f.src = 'https://www.youtube-nocookie.com/embed/WifwNFpG96o?autoplay=1&rel=0&playsinline=1';
      back.firstChild.append(f);
      const playing = !tv.paused; tv.pause();
      const close = closeWatch = () => { closeWatch = null; back.remove(); removeEventListener('keydown', esc); if (playing && tv.isConnected) tv.play().catch(() => {}); };
      const esc = ev => { if (ev.key === 'Escape') close(); };
      back.addEventListener('click', ev => { if (ev.target === back || ev.target.closest('.x')) close(); });
      addEventListener('keydown', esc);
      document.body.append(back);
    });
    el.querySelector('#su-tvbtn').addEventListener('click', e => { e.stopPropagation(); el.querySelector('#su-watch').click(); });
    // Support me: Buy Me a Coffee's support panel, as on the VF1 and FunKey pages. This page is cross-origin isolated (the
    // game's memory is shared with its worker), so BMC's own widget can't embed its page here, but a credentialless iframe
    // can (Chrome, Edge). Where there's none (Safari, Firefox) the panel opens in a small window of its own.
    const BMC = 'https://www.buymeacoffee.com/widget/page/mrfinster?description=' + encodeURIComponent('Support me on Buy me a coffee!') +
      '&color=' + encodeURIComponent('#BD5FFF');
    const sup = el.querySelector('#su-support');
    sup.addEventListener('click', e => {
      e.preventDefault();
      if (!('credentialless' in HTMLIFrameElement.prototype)) {
        const w = 420, h = Math.min(760, screen.availHeight - 60);
        window.open(BMC, 'bmc', `popup,width=${w},height=${h},left=${(screen.availLeft || 0) + screen.availWidth - w - 24},top=${(screen.availTop || 0) + 24}`);
        return;
      }
      if (document.getElementById('su-bmc')) return;
      const wide = matchMedia('(min-width: 480px)').matches;   // BMC's widget: a panel at the right, or the whole phone screen
      const back = document.createElement('div');
      back.id = 'su-bmc';
      back.style.cssText = 'position:fixed;inset:0;z-index:2147483000;cursor:pointer';
      const f = document.createElement('iframe');
      f.credentialless = true;                                // before its src: without it the page is blocked here
      f.title = 'Buy Me a Coffee';
      f.allow = 'payment *';
      f.style.cssText = 'position:fixed;border:0;background:#fff;cursor:auto;' + (wide
        ? `right:18px;bottom:90px;width:420px;max-width:100vw;height:${innerHeight - 120}px;border-radius:10px;box-shadow:-6px 0 30px rgba(13,12,34,.1)`
        : 'inset:0;width:100%;height:100%');
      f.src = BMC;
      back.append(f);
      const close = () => { back.remove(); removeEventListener('keydown', esc); };
      const esc = ev => { if (ev.key === 'Escape') close(); };
      back.addEventListener('click', ev => { if (ev.target === back) close(); });
      if (!wide) {
        const x = document.createElement('button');
        x.setAttribute('aria-label', 'Close');
        x.innerHTML = '<svg width="16" height="16" viewBox="0 0 28 28"><path d="M2.45 27.65L.35 25.55 11.9 14 .35 2.45 2.45.35 14 11.9 25.55.35 27.65 2.45 16.1 14 27.65 25.55 25.55 27.65 14 16.1z" fill="#666"/></svg>';
        x.style.cssText = 'position:fixed;top:16px;right:16px;width:40px;height:40px;border:0;border-radius:100px;background:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer';
        x.onclick = close;
        back.append(x);
      }
      document.body.append(back);
      addEventListener('keydown', esc);
    });
  }
  root.StuntsSetup = { load, store, forget, show, collect, complete: files => !missing(files).length };
})(self);
