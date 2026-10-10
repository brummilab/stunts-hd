// Headless harness: boots FreeDOS + Stunts in v86 under Node, for development and testing.
// usage: node emu.js <script.json>   (or require and drive it)
'use strict';
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const ROOT = path.join(__dirname, '..', '..');
globalThis.ImageData = globalThis.ImageData || class { constructor(d, w, h) { this.data = d; this.width = w; this.height = h; } };

async function boot(opts = {}) {
  const { V86 } = await import(require('url').pathToFileURL(path.join(ROOT, 'vendor/v86/package/build/libv86.mjs')).href);
  const buf = p => { const b = fs.readFileSync(path.join(ROOT, p)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); };
  const emu = new V86({
    wasm_path: path.join(ROOT, 'vendor/v86/package/build/v86.wasm'),
    memory_size: 32 * 1024 * 1024, vga_memory_size: 2 * 1024 * 1024,
    bios: { buffer: buf('vendor/v86/seabios.bin') }, vga_bios: { buffer: buf('vendor/v86/vgabios.bin') },
    fda: { buffer: buf('vendor/v86/freedos722.img') }, hda: { buffer: buf(opts.hda || 'stunts/gen/stunts-hd.img') },
    boot_order: 0x321, autostart: true, disable_speaker: true,
  });
  return new Promise(res => emu.add_listener('emulator-ready', () => res(emu)));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Text screen rows (text mode lives in VGA plane memory: char/attr interleaved via planes 0/1)
function textScreen(emu) {
  const vga = emu.v86.cpu.devices.vga, out = [];
  const mem = vga.vga_memory, p0 = mem.subarray(0, 0x10000);
  const start = vga.start_address;
  for (let r = 0; r < 25; r++) { let s = ''; for (let c = 0; c < 80; c++) { const ch = p0[start + r * 80 + c]; s += ch >= 32 && ch < 127 ? String.fromCharCode(ch) : ' '; } out.push(s.trimEnd()); }
  return out.filter(Boolean).join('\n');
}
// Graphics framebuffer as palette indices + palette
function frame(emu) {
  const vga = emu.v86.cpu.devices.vga;
  vga.complete_redraw(); vga.screen_fill_buffer();
  return { w: vga.screen_width, h: vga.screen_height, idx: vga.pixel_buffer.slice(0, vga.screen_width * vga.screen_height), pal: Array.from(vga.vga256_palette.slice(0, 256)), graphical: vga.graphical_mode };
}
function png(f, file) {
  const { w, h, idx, pal } = f, raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w; x++) { const c = pal[idx[y * w + x]]; const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = c >> 16 & 255; raw[o + 1] = c >> 8 & 255; raw[o + 2] = c & 255; } }
  const crc = b => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = c >>> 1 ^ (0xEDB88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 2;
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}
module.exports = { boot, sleep, textScreen, frame, png };

if (require.main === module) (async () => {
  const out = process.argv[2] || '/tmp';
  const emu = await boot();
  for (let i = 0; i < 60; i++) { await sleep(500); if (/A:\\>\s*$/.test(textScreen(emu))) break; }
  console.log('--- DOS ready ---\n' + textScreen(emu).split('\n').slice(-3).join('\n'));
  emu.keyboard_send_text('C:\\RUN\n');
  for (let i = 0; i < 16; i++) {
    await sleep(1000);
    const f = frame(emu);
    console.log(i + 's', f.graphical ? `graphics ${f.w}x${f.h}` : 'text: ' + textScreen(emu).split('\n').slice(-2).join(' | '));
    if (f.graphical) png(f, path.join(out, 'stunts-' + i + '.png'));
  }
  emu.stop(); process.exit(0);
})();
