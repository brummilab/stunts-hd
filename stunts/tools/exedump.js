// dev tool: decodes the game executable at every code offset (for tools/mapcheck.py) and lists its relocations
//   node tools/exedump.js <exe> <out.json>
'use strict';
const fs = require('fs'); const { decode } = require('../x86dec.js');
const [exeF, outF] = process.argv.slice(2);
const exe = fs.readFileSync(exeF), hdr = exe.readUInt16LE(8) * 16, img = exe.subarray(hdr);
const nrel = exe.readUInt16LE(6), relo = exe.readUInt16LE(0x18), relocs = [];
for (let i = 0; i < nrel; i++) relocs.push(exe.readUInt16LE(relo + i * 4 + 2) * 16 + exe.readUInt16LE(relo + i * 4));
const END = +(process.env.END || 0x2B770), ins = [];
for (let a = 0; a < END; a++) { const d = decode(img, a); ins.push([d.len, d.op, d.args, d.rel == null ? null : d.rel, d.far || null, d.abs == null ? null : d.abs]); }
fs.writeFileSync(outF, JSON.stringify({ relocs, ins, img: img.toString('base64') }));
console.log('decoded', ins.length, 'offsets,', relocs.length, 'relocations');
