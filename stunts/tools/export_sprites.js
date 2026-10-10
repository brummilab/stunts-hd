// Export every 2D image in the Stunts data (VGA .PVS and EGA .PES) as PNG, for upscaling.
// Decoding follows Restunts shape2d.c (file_unflip_shape2d, file_unflip_shape2d_pes,
// file_load_shape2d_expand). Colours come from the game palette (SDMAIN.PVS !pal).
// usage: node export_sprites.js <stunts data dir> <out dir>
'use strict';
const fs = require('fs'), path = require('path'), zlib = require('zlib');
require('../data.js');
const D = globalThis.StuntsData;
const [SRC, OUT] = process.argv.slice(2);

function png(w, h, rgba, file) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  const crcT = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
  const crc = b => { let c = ~0; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return ~c >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 6;
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]));
}

// EGA shapes: bit planes, optionally transposed, each plane ORs its colour nibble into the pixel
function parsePES(b) {
  const wB = D.u16(b, 0), h = D.u16(b, 2), x = D.s16(b, 8), y = D.s16(b, 10);
  const len = wB * h, planes = [];
  let flip = (b[15] & 0xF0) ? 0 : (b[14] >> 4) & 0x0F;
  for (let j = 0; j < 4; j++) {
    let p = b.subarray(16 + j * len, 16 + (j + 1) * len);
    if (flip & 1) { const o = new Uint8Array(len); for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < wB; xx++) o[yy * wB + xx] = p[xx * h + yy]; p = o; }
    planes.push(p); flip >>= 1;
  }
  const w = wB * 8, px = new Uint8Array(w * h).fill(b[13] >> 4);
  for (let j = 0; j < 4; j++) {
    const pat = b[12 + j] & 0x0F; if (!pat) break;
    const p = planes[j];
    for (let k = 0; k < len; k++) { let v = p[k]; for (let l = 0; l < 8; l++) { if (v & 0x80) px[k * 8 + l] |= pat; v = (v << 1) & 0xFF; } }
  }
  return { w, h, x, y, px };
}

const pal0 = D.parseRes(D.decompress(new Uint8Array(fs.readFileSync(path.join(SRC, 'SDMAIN.PVS')))))['!pal'];
const manifest = [];
let count = 0;
for (const f of fs.readdirSync(SRC).sort()) {
  const ext = path.extname(f).toUpperCase();
  if (ext !== '.PVS' && ext !== '.PES') continue;
  const res = D.parseRes(D.decompress(new Uint8Array(fs.readFileSync(path.join(SRC, f)))));
  const pal = res['!pal'] || pal0;
  const dir = path.join(OUT, path.basename(f, path.extname(f)).toUpperCase());
  for (const [name, b] of Object.entries(res)) {
    if (name[0] === '!') continue;
    let sp;
    try { sp = ext === '.PES' ? parsePES(b) : D.parseShape2D(b); } catch (e) { console.warn(f, name, e.message); continue; }
    if (!sp.w || !sp.h) continue;
    const rgba = Buffer.alloc(sp.w * sp.h * 4);
    for (let i = 0; i < sp.w * sp.h; i++) {
      const c = sp.px[i], o = i * 4;
      rgba[o] = pal[16 + c * 3] * 255 / 63; rgba[o + 1] = pal[17 + c * 3] * 255 / 63; rgba[o + 2] = pal[18 + c * 3] * 255 / 63;
      rgba[o + 3] = c === 0 ? 0 : 255;   // colour 0 is see-through when the game draws a sprite
    }
    fs.mkdirSync(dir, { recursive: true });
    const safe = name.replace(/[^\w]/g, '_') || 'shape';
    png(sp.w, sp.h, rgba, path.join(dir, safe + '.png'));
    manifest.push({ file: f, resource: name, png: path.relative(OUT, path.join(dir, safe + '.png')), width: sp.w, height: sp.h, screenX: sp.x, screenY: sp.y });
    count++;
  }
}
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 1));
console.log('exported', count, 'images to', OUT);
