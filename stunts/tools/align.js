// Lines up the Restunts disassembly (asmorig) with the game executable, instruction by instruction, using
// x86dec.js: the check that the browser can decode the player's own GAME.EXE into what the translator expects.
//   node tools/align.js <asmorig dir> <exe>     (prints mismatches and a summary)
'use strict';
const fs = require('fs'), path = require('path');
const { decode } = require('../x86dec.js');
const [dir, exeF] = process.argv.slice(2);
const exe = fs.readFileSync(exeF), img = exe.subarray(exe.readUInt16LE(8) * 16);
const BASE = +(process.env.BASE || 0x10000);
const SKIP = new Set(['proc', 'endp', 'assume', 'public', 'extrn', 'include', 'end', 'ends', 'segment', 'label', 'org', 'model', 'nosmart', 'smart', 'locals', 'nolocals', 'jumps', 'nojumps']);
const SIZE = { db: 1, dw: 2, dd: 4, dq: 8, dt: 10 };
const NORM = { je: 'jz', jne: 'jnz', jae: 'jnb', jnae: 'jb', jc: 'jb', jnc: 'jnb', jna: 'jbe', jnbe: 'ja', jnge: 'jl', jnl: 'jge', jng: 'jle', jnle: 'jg', jpe: 'jp', jpo: 'jnp', sal: 'shl', ret: 'retn', repe: 'rep', repz: 'rep', repnz: 'repne' };
const norm = m => NORM[m] || m;
function dataSize(kw, rest) {   // bytes a db/dw/dd line takes
  const w = SIZE[kw]; let n = 0;
  const items = []; let cur = '', q = null, depth = 0;
  for (const ch of rest) { if (q) { cur += ch; if (ch === q) q = null; continue; } if (ch === "'" || ch === '"') { q = ch; cur += ch; continue; } if (ch === '(') depth++; if (ch === ')') depth--; if (ch === ',' && !depth) { items.push(cur.trim()); cur = ''; } else cur += ch; }
  if (cur.trim()) items.push(cur.trim());
  for (const it of items) {
    let m;
    if ((m = /^(\S+)\s+dup\s*\((.*)\)$/i.exec(it))) { const c = parseInt(m[1].replace(/h$/i, ''), /h$/i.test(m[1]) ? 16 : 10); n += c * dataSize(kw, m[2]); }
    else if (/^['"]/.test(it) && kw === 'db') n += it.length - 2;
    else n += w;
  }
  return n;
}
let ok = 0, bad = 0, labelsOk = 0, labelsBad = 0; const shown = [];
const files = fs.readdirSync(dir).filter(f => /^seg\d+\.asm$/.test(f)).sort();
for (const f of files) {
  const lines = fs.readFileSync(path.join(dir, f), 'latin1').split(/\r?\n/);
  let cur = null;
  for (let raw of lines) {
    const l = raw.replace(/;.*$/, '').replace(/\s+$/, '');
    if (!l.trim()) continue;
    // a label with its address in its name pins the cursor
    let m = /^([A-Za-z_@$?][\w@$?]*)\s*(?::|\s+(?:proc|label|db|dw|dd|dt|dq)\b)/.exec(l);
    if (m) {
      const a = /^(?:loc|sub|locret|byte|word|dword|off|unk|stru|asc|nullsub|j_sub|algn)_([0-9A-F]{4,6})$/.exec(m[1]);   // (IDA's own names carry their address)
      if (a) { const off = parseInt(a[1], 16) - BASE; if (cur !== null && cur !== off) { labelsBad++; if (shown.length < 60) shown.push(`${f}: label ${m[1]} at ${cur.toString(16)} (expected ${off.toString(16)})`); } else labelsOk++; cur = off; }
      const after = l.slice(m[0].length - (/:$/.test(m[0]) ? 0 : m[0].split(/\s+/).pop().length)).trim();
      const dm = /^(db|dw|dd|dt|dq)\s+(.*)$/.exec(after);
      if (dm && cur !== null) cur += dataSize(dm[1], dm[2]);
      continue;
    }
    const t = l.trim(), op = t.split(/\s+/)[0].toLowerCase();
    if (/^[\w@$?.]+\s*(=|equ\b)/i.test(t)) continue;   // (equates: var_12 = word ptr -18)
    if (SKIP.has(op) || /^\./.test(t) || / segment |\bends$|\bendp$/.test(t)) continue;
    if (SIZE[op]) { if (cur !== null) cur += dataSize(op, t.slice(op.length).trim()); continue; }
    if (cur === null) continue;
    const d = decode(img, cur);
    if (op === 'nop' && d.op !== 'nop') { ok++; continue; }   // (TASM's padding: the exe holds the longer form of the next instruction)
    let want = norm(op); if (want === 'rep' || want === 'repne') want = want + ' ' + norm(t.split(/\s+/)[1] || '');
    let got = d.op.replace(/^repe /, 'rep '); got = got.split(' ').map(norm).join(' ');
    if (want === 'retf' && got === 'retf' || want === got || (want === 'retn' && got === 'retn') || (want === 'call' && got === 'call') ) ok++;
    else { bad++; if (shown.length < 60) shown.push(`${f} @${cur.toString(16)}: asm "${t}" vs exe "${d.op} ${d.args.join(', ')}"`); }
    cur += d.len;
  }
}
console.log(`instructions matched ${ok}, mismatched ${bad}; address labels consistent ${labelsOk}, off ${labelsBad}`);
for (const s of shown) console.log('  ' + s);
