// The game's code, translated in the browser from the player's own GAME.EXE: x86dec.js decodes each instruction,
// map.json (names and positions only) puts back the labels, names and pointers, and the translation below is
// tools/asm2js.py's, line for line. The result is the same JavaScript as gen/code.js.
//   StuntsTranslate({ img, relocs } (exefile.js), map) -> { source (defines root.StuntsCode), errors, procs }
'use strict';
(function (root) {
  const SIZES = { byte: 1, word: 2, dword: 4, qword: 8, tbyte: 10 };
  const REG16 = ['ax', 'cx', 'dx', 'bx', 'sp', 'bp', 'si', 'di'];
  const REG8 = { al: ['ax', 0], ah: ['ax', 8], bl: ['bx', 0], bh: ['bx', 8], cl: ['cx', 0], ch: ['cx', 8], dl: ['dx', 0], dh: ['dx', 8] };
  const SREG = ['es', 'cs', 'ss', 'ds'];
  const COND = {
    jz: 'r.zf', je: 'r.zf', jnz: '!r.zf', jne: '!r.zf',
    jl: '(!r.sf !== !r.of)', jnge: '(!r.sf !== !r.of)', jge: '(!r.sf === !r.of)', jnl: '(!r.sf === !r.of)',
    jle: '(r.zf || !r.sf !== !r.of)', jng: '(r.zf || !r.sf !== !r.of)', jg: '(!r.zf && !r.sf === !r.of)', jnle: '(!r.zf && !r.sf === !r.of)',
    jb: 'r.cf', jc: 'r.cf', jnae: 'r.cf', jnb: '!r.cf', jae: '!r.cf', jnc: '!r.cf',
    jbe: '(r.cf || r.zf)', jna: '(r.cf || r.zf)', ja: '(!r.cf && !r.zf)', jnbe: '(!r.cf && !r.zf)',
    js: 'r.sf', jns: '!r.sf', jo: 'r.of', jno: '!r.of', jp: 'r.pf', jnp: '!r.pf', jpe: 'r.pf', jpo: '!r.pf',
    jcxz: '(r.cx === 0)',
  };
  const ALU = new Set(['add', 'adc', 'sub', 'sbb', 'cmp', 'and', 'or', 'xor', 'test']);
  // json.dumps as Python writes it (', ' and ': ', non-ASCII escaped), so the output matches gen/code.js
  const jstr = v => '"' + v.replace(/[\\"\u0000-\u001f\u007f-￿]/g, c => ({ '\\': '\\\\', '"': '\\"', '\n': '\\n', '\r': '\\r', '\t': '\\t', '\b': '\\b', '\f': '\\f' })[c] || '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')) + '"';
  const J = v => v === null || v === undefined ? 'null' : typeof v === 'string' ? jstr(v) : typeof v === 'number' ? String(v)
    : Array.isArray(v) ? '[' + v.map(J).join(', ') + ']' : '{' + Object.entries(v).map(([k, x]) => jstr(k) + ': ' + J(x)).join(', ') + '}';
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

  function stripComment(l) {
    let out = '', q = null;
    for (const ch of l) {
      if (q) { out += ch; if (ch === q) q = null; }
      else if (ch === "'" || ch === '"') { q = ch; out += ch; }
      else if (ch === ';') break;
      else out += ch;
    }
    return out.replace(/\s+$/, '');
  }
  function num(tok) {
    const t = tok.trim();
    if (/^'.'$/.test(t)) return t.charCodeAt(1);
    if (/^[0-9][0-9a-fA-F]*[hH]$/.test(t)) return parseInt(t.slice(0, -1), 16);
    if (/^\d+$/.test(t)) return parseInt(t, 10);
    if (/^[01]+[bB]$/.test(t)) return parseInt(t.slice(0, -1), 2);
    return null;
  }

  function translateAll(prog, MAP) {
    const IMG = prog.img;
    const STRUCTS = MAP.structs, CONSTS = MAP.consts, DSYM = MAP.dsym, DSIZE = MAP.dsize, DTYPE = MAP.dtype;
    const CSDATA = MAP.csym, CSTYPE = MAP.cstype || {}, CODESEG_OF = MAP.codeseg_of, PROBES = new Set(MAP.probes);
    const DSEG = 0x1000, CODESEG = 0xF000;
    const fieldPath = path => {
      const parts = path.split('.');
      if (!has(STRUCTS, parts[0])) return null;
      let st = parts[0], off = 0, size = STRUCTS[parts[0]].size;
      for (const p of parts.slice(1)) {
        if (!st || !has(STRUCTS[st].fields, p)) return null;
        const f = STRUCTS[st].fields[p]; off += f[0]; const t = f[2];
        if (has(STRUCTS, t)) { st = t; size = STRUCTS[t].size; } else { size = f[1]; st = null; }
      }
      return [off, size];
    };
    const memberPath = (typename, parts) => {
      let st = typename, off = 0, size = null;
      for (const p of parts) {
        if (!st || !has(STRUCTS, st) || !has(STRUCTS[st].fields, p)) return null;
        const f = STRUCTS[st].fields[p]; off += f[0]; const t = f[2];
        if (has(STRUCTS, t)) { st = t; size = STRUCTS[t].size; } else size = f[1];
      }
      return [off, size];
    };
    function evalConst(e) {
      let e2 = e.replace(/\bsize\s+(\w+)/g, (m, n) => String(STRUCTS[n].size));
      e2 = e2.replace(/'.'|[A-Za-z_]\w*(?:\.\w+)*|[0-9][0-9a-fA-F]*[hH]|\d+/g, t => {
        const v = num(t); if (v !== null) return String(v);
        const fp = fieldPath(t); if (fp) return String(fp[0]);
        if (has(STRUCTS, t)) return String(STRUCTS[t].size);
        if (has(CONSTS, t)) return String(CONSTS[t]);
        const err = new Error(t); err.plain = true; throw err;
      });
      return arith(e2);
    }
    // + - * / ( ) on whole numbers, / rounding down as Python's //
    function arith(e) {
      const tk = e.match(/\d+|[-+*/()]|\S/g) || []; let i = 0;
      const atom = () => {
        const t = tk[i++];
        if (t === '-') return -atom();
        if (t === '+') return atom();
        if (t === '(') { const v = sum(); if (tk[i++] !== ')') throw new Error('expr ' + e); return v; }
        if (/^\d+$/.test(t || '')) return parseInt(t, 10);
        throw new Error('expr ' + e);
      };
      const prod = () => { let v = atom(); while (tk[i] === '*' || tk[i] === '/') { const o = tk[i++], w = atom(); if (o === '*') v *= w; else { if (!w) throw new Error('div0'); v = Math.floor(v / w); } } return v; };
      const sum = () => { let v = prod(); while (tk[i] === '+' || tk[i] === '-') { const o = tk[i++], w = prod(); v = o === '+' ? v + w : v - w; } return v; };
      const v = sum(); if (i !== tk.length) throw new Error('expr ' + e); return v;
    }

    // ---- procs: the map's lines, instructions decoded from GAME.EXE and named
    const A2L = new Map(Object.entries(MAP.a2l).map(([a, n]) => [+a, n]));   // address -> label (jump and call targets)
    const RELOC = new Set(prog.relocs);
    const SEGNAME = new Map(Object.entries(MAP.segname).map(([v, n]) => [+v, n]));
    const paraOf = a => { let p = null; for (const [s0, pp] of MAP.segs) if (s0 <= a) p = pp; return p; };   // (segs: [start, para, file], sorted)
    function rebuild(addr) {
      const d = root.X86Dec.decode(IMG, addr);
      const args = d.args.slice();
      if (d.rel != null) return d.op + (d.op === 'call' ? ' near ptr ' : ' ') + (A2L.get(d.rel) || 'loc_' + (d.rel + 0x10000).toString(16).toUpperCase());
      if (d.far) { const t = d.far[0] * 16 + d.far[1]; return d.op + ' far ptr ' + (A2L.get(t) || 'loc_' + (t + 0x10000).toString(16).toUpperCase()); }
      if (d.op === 'jmp' && args.length && args[0].includes('cs:[')) {
        const m = /^word ptr cs:\[(\w+)\+(\w+)\]$/.exec(args[0]), pp = paraOf(addr);
        if (m && pp != null) { const n = A2L.get(pp * 16 + num(m[2])); if (n) return 'jmp cs:' + n + '[' + m[1] + ']'; }
      }
      for (let k = 0; k < d.len; k++) if (RELOC.has(addr + k)) {
        const v = IMG[addr + k] | IMG[addr + k + 1] << 8, sn = SEGNAME.get(v);
        if (sn && args.length) args[args.length - 1] = 'seg ' + sn;
        break;
      }
      if (['int', 'in', 'out', 'hlt', 'wait'].includes(d.op)) return (d.op.padEnd(8) + args.join(', ')).replace(/\s+$/, '');
      return (d.op + ' ' + args.join(', ')).trim();
    }
    const PROCS = {};
    for (const p of MAP.procs) {
      const lines = [];
      for (const it of p.items) {
        if (it[0] === 't') lines.push(it[1]);
        else lines.push('    ' + (it.length > 2 ? it[2] : rebuild(it[1])));
      }
      PROCS[p.name] = { name: p.name, kind: p.kind, file: p.file, next: p.next, lines };
    }
    const CODE_SYMS = {};
    Object.keys(PROCS).sort().forEach((n, i) => { CODE_SYMS[n] = 0x100 + i * 4; });
    // global labels: label -> (proc, case number)
    const GLABELS = {}, GADDR = {};
    let gcount = 0;
    for (const [pname, p] of Object.entries(PROCS)) {
      let c = 1;
      for (const raw of p.lines) {
        const l = stripComment(raw);
        const ml = /^(\w+)\s+label\s+(near|far|byte|word|dword)\s*$/i.exec(l.trim()), mm = /^(\w+):/.exec(l.trim());
        const nm = ml ? ml[1] : (mm && !/^(es|ds|ss|cs)$/i.test(mm[1]) ? mm[1] : null);
        if (nm) { GLABELS[nm] = [pname, c]; GADDR[nm] = 0xC000 + gcount++; c++; }
      }
    }

    // ---- operands
    class Op { constructor(kind, kw) { this.kind = kind; Object.assign(this, kw); } }
    function parseOperand(s, ctx) {
      s = s.trim(); let size = null, m;
      if ((m = /^(byte|word|dword)\s+ptr\s+(.*)$/i.exec(s))) { size = SIZES[m[1].toLowerCase()]; s = m[2].trim(); }
      if ((m = /^(near|far)\s+ptr\s+(.*)$/i.exec(s))) s = m[2].trim();
      const low = s.toLowerCase();
      if (REG16.includes(low)) return new Op('reg', { r: low, size: 2 });
      if (has(REG8, low)) return new Op('reg8', { r: REG8[low][0], sh: REG8[low][1], size: 1 });
      if (low === 'cs' && ctx) return new Op('imm', { v: has(CODESEG_OF, ctx.proc.file) ? CODESEG_OF[ctx.proc.file] : CODESEG, size: 2 });
      if (SREG.includes(low)) return new Op('sreg', { r: low, size: 2 });
      let seg = null;
      if ((m = /^(es|ds|ss|cs):(.*)$/i.exec(s))) { seg = m[1].toLowerCase(); s = m[2].trim(); }
      if (!s.includes('[') && !seg) { try { return new Op('imm', { v: immExpr(s, ctx), size }); } catch (_) {} }
      s = s.replace(/\bsize\s+(\w+)/g, (mm, n) => String(STRUCTS[n].size));
      s = s.replace(/(^|\+)\s*\(([^()]*)\)/g, (mm, a, b) => a + b);
      const expr = s.split('[').join('+').split(']').join('');
      const regs = []; let disp = 0, sym = null, esize = null, symseg = null;
      const toks = expr.match(/[+-]?\s*(?:\([^)]*\)|[\w.']+)/g) || [];
      for (let t of toks) {
        const sign = t.trim().startsWith('-') ? -1 : 1;
        t = t.trim().replace(/^[+-]+/, '').trim();
        if (!t) continue;
        if (t.startsWith('(')) { disp += sign * immExpr(t.slice(1, -1), ctx); continue; }
        const tl = t.toLowerCase();
        if (['bx', 'bp', 'si', 'di'].includes(tl)) { regs.push(tl); continue; }
        const v = num(t);
        if (v !== null) { disp += sign * v; continue; }
        const parts = t.split('.'), base = parts[0], rest = parts.slice(1);
        if (has(ctx.locals, base)) {
          const [off, tsz, tname] = ctx.locals[base]; disp += sign * off;
          if (rest.length) { const mp = memberPath(tname, rest); disp += sign * mp[0]; esize = esize || mp[1]; } else esize = esize || tsz;
          continue;
        }
        const fp = fieldPath(t);
        if (fp) { disp += sign * fp[0]; esize = esize || fp[1]; continue; }
        if (has(DSYM, base)) {
          sym = base; disp += sign * DSYM[base];
          if (rest.length) { const mp = memberPath(DTYPE[base], rest); disp += sign * mp[0]; esize = esize || mp[1]; } else esize = esize || (has(DSIZE, base) ? DSIZE[base] : null);
          continue;
        }
        if (has(ctx.tables, base)) { sym = base; symseg = 'cs'; esize = 2; continue; }
        if (has(CSDATA, base)) {
          const [segv, off, w] = CSDATA[base]; sym = base; symseg = 'const:' + segv; disp += sign * off;
          if (rest.length) { const mp = memberPath(CSTYPE[base], rest); disp += sign * mp[0]; esize = esize || mp[1]; } else esize = esize || w;
          continue;
        }
        if (has(STRUCTS, base)) { disp += sign * STRUCTS[base].size; continue; }
        if (has(CONSTS, base)) { disp += sign * CONSTS[base]; continue; }
        if (has(CODE_SYMS, base)) { disp += sign * CODE_SYMS[base]; continue; }
        throw new Error('unknown symbol ' + t);
      }
      if (symseg && symseg.startsWith('const:')) seg = symseg;
      if (!seg) seg = regs.includes('bp') ? 'ss' : (symseg === 'cs' ? 'cs' : 'ds');
      if (seg === 'cs' && symseg !== 'cs') seg = 'const:' + (has(CODESEG_OF, ctx.proc.file) ? CODESEG_OF[ctx.proc.file] : 0);
      return new Op('mem', { regs, disp, seg, size: size || esize, table: symseg === 'cs' ? sym : null });
    }
    function immExpr(s, ctx) {
      s = s.trim();
      while (s.startsWith('(') && s.endsWith(')') && (s.match(/\(/g) || []).length === 1) s = s.slice(1, -1).trim();
      let m;
      if ((m = /^offset\s+(.*)$/i.exec(s))) {
        const t = m[1].trim(), mm = /^(\w+)((?:\.\w+)*)\s*([+-].*)?$/.exec(t);
        if (!mm) throw new Error('offset expr ' + t);
        const base = mm[1], extra = mm[3], dotted = mm[2] ? mm[2].slice(1).split('.') : [];
        let v;
        if (has(DSYM, base)) { v = DSYM[base]; if (dotted.length) v += memberPath(DTYPE[base], dotted)[0]; }
        else if (has(CSDATA, base)) v = CSDATA[base][1];
        else if (has(CODE_SYMS, base)) v = CODE_SYMS[base];
        else if (has(ctx.labels, base)) v = 0x8000 + ctx.labels[base];
        else if (has(GADDR, base)) v = GADDR[base];
        else { const fp = fieldPath(t); if (fp) return fp[0]; throw new Error('offset of ' + t); }
        if (extra) v += extra[0] !== '+' ? evalConst(extra) : evalConst(extra.slice(1));
        return v & 0xFFFF;
      }
      if ((m = /^seg\s+(\w+)$/i.exec(s))) {
        const n = m[1];
        if (has(DSYM, n) || n.toLowerCase() === 'dseg') return DSEG;
        if (has(CSDATA, n)) return CSDATA[n][0];
        if (has(CODESEG_OF, n + '.asm')) return CODESEG_OF[n + '.asm'];
        if (has(PROCS, n)) return has(CODESEG_OF, PROCS[n].file) ? CODESEG_OF[PROCS[n].file] : CODESEG;
        return CODESEG;
      }
      if (has(ctx.locals, s)) return ctx.locals[s][0];
      if (has(DSYM, s)) throw new Error('symbol used as immediate: ' + s);
      return evalConst(s);
    }
    const ea = op => { const parts = op.regs.map(x => 'r.' + x); if (op.disp) parts.push(String(op.disp & 0xFFFF)); return '((' + (parts.length ? parts.join(' + ') : '0') + ') & 0xFFFF)'; };
    const segexpr = op => op.seg.startsWith('const:') ? op.seg.slice(6) : 'r.' + op.seg;
    function rd(op, size) {
      if (op.kind === 'reg') return 'r.' + op.r;
      if (op.kind === 'reg8') return op.sh ? `((r.${op.r} >> ${op.sh}) & 0xFF)` : `(r.${op.r} & 0xFF)`;
      if (op.kind === 'sreg') return 'r.' + op.r;
      if (op.kind === 'imm') return String(size === 1 ? op.v & 0xFF : size === 2 ? op.v & 0xFFFF : op.v >>> 0);
      return `m.${{ 1: 'rb', 2: 'rw', 4: 'rd' }[size]}(${segexpr(op)}, ${ea(op)})`;
    }
    function wr(op, size, val) {
      if (op.kind === 'reg') return `r.${op.r} = (${val}) & 0xFFFF;`;
      if (op.kind === 'reg8') return op.sh ? `r.${op.r} = (r.${op.r} & 0x00FF) | (((${val}) & 0xFF) << 8);` : `r.${op.r} = (r.${op.r} & 0xFF00) | ((${val}) & 0xFF);`;
      if (op.kind === 'sreg') return `r.${op.r} = (${val}) & 0xFFFF;`;
      return `m.${{ 1: 'wb', 2: 'ww', 4: 'wd' }[size]}(${segexpr(op)}, ${ea(op)}, ${val});`;
    }
    function opsize(a, b, dflt = 2) {
      for (const o of [a, b]) if (o && ['reg', 'reg8', 'sreg'].includes(o.kind)) return o.size;
      for (const o of [a, b]) if (o && o.kind === 'mem' && o.size) return o.size;
      for (const o of [a, b]) if (o && o.kind === 'imm' && o.size) return o.size;
      return dflt;
    }
    function splitOps(s) {
      const out = []; let cur = '', depth = 0, q = null;
      for (const ch of s) {
        if (q) { cur += ch; if (ch === q) q = null; }
        else if (ch === "'" || ch === '"') { q = ch; cur += ch; }
        else if (ch === '[' || ch === '(') { depth++; cur += ch; }
        else if (ch === ']' || ch === ')') { depth--; cur += ch; }
        else if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; }
        else cur += ch;
      }
      if (cur.trim()) out.push(cur.trim());
      return out;
    }
    const flagsLogic = (res, size) => { const mask = size === 1 ? 0xFF : 0xFFFF, sb = size === 1 ? 0x80 : 0x8000; return `r.cf = 0; r.of = false; r.zf = ((${res}) & ${mask}) === 0; r.sf = ((${res}) & ${sb}) !== 0;`; };
    function jumpTarget(name, ctx) {
      if (has(ctx.labels, name)) {
        if (ctx.labels[name] <= ctx.cur) return `if (--m.budget < 0) m.poll(r, P); pc = ${ctx.labels[name]}; continue;`;
        return `pc = ${ctx.labels[name]}; continue;`;
      }
      if (name === ctx.proc.name) return 'if (--m.budget < 0) m.poll(r, P); pc = 0; continue;';
      if (has(PROCS, name)) return `P[${J(name)}](r, m, P); return;`;
      if (has(GLABELS, name)) { const [pr, idx] = GLABELS[name]; return `P[${J(pr)}](r, m, P, ${idx}); return;`; }
      throw new Error('jump target ' + name);
    }
    function translateIns(text, ctx) {
      let t = text, prefix = null, m;
      if ((m = /^(rep|repe|repz|repne|repnz)\s+(.*)$/i.exec(t))) { prefix = m[1].toLowerCase(); t = m[2].trim(); }
      m = /^(\w+)\s*(.*)$/.exec(t);
      const mn = m[1].toLowerCase(), rest = m[2].trim(), ops = splitOps(rest);
      if (['nop', 'cld', 'std', 'cli', 'sti', 'smart', 'nosmart'].includes(mn)) return mn === 'cld' ? 'r.df = 0;' : mn === 'std' ? 'r.df = 1;' : ';';
      if (mn === 'clc') return 'r.cf = 0;';
      if (mn === 'stc') return 'r.cf = 1;';
      if (mn === 'cmc') return 'r.cf = r.cf ? 0 : 1;';
      if (mn === 'cbw') return 'r.ax = ((r.ax & 0x80) ? 0xFF00 : 0) | (r.ax & 0xFF);';
      if (mn === 'cwd') return 'r.dx = (r.ax & 0x8000) ? 0xFFFF : 0;';
      if (mn === 'lahf') return 'r.ax = (r.ax & 0xFF) | ((r.sf ? 0x80 : 0) | (r.zf ? 0x40 : 0) | (r.cf ? 1 : 0) | 2) << 8;';
      if (mn === 'sahf') return 't = r.ax >> 8; r.sf = !!(t & 0x80); r.zf = !!(t & 0x40); r.cf = t & 1;';
      if (mn === 'pushf') return 'm.push(r, (r.cf ? 1 : 0) | (r.zf ? 0x40 : 0) | (r.sf ? 0x80 : 0) | (r.of ? 0x800 : 0) | (r.df ? 0x400 : 0) | 2);';
      if (mn === 'popf') return 't = m.pop(r); r.cf = t & 1; r.zf = !!(t & 0x40); r.sf = !!(t & 0x80); r.of = !!(t & 0x800); r.df = (t >> 10) & 1;';
      if (['in', 'out', 'int', 'hlt', 'wait'].includes(mn)) return `m.io(r, ${J(text)});`;
      if (mn === 'mov') { const a = parseOperand(ops[0], ctx), b = parseOperand(ops[1], ctx), sz = opsize(a, b); return wr(a, sz, rd(b, sz)); }
      if (mn === 'xchg') { const a = parseOperand(ops[0], ctx), b = parseOperand(ops[1], ctx), sz = opsize(a, b); return `t = ${rd(a, sz)}; ${wr(a, sz, rd(b, sz))} ${wr(b, sz, 't')}`; }
      if (mn === 'lea') { const a = parseOperand(ops[0], ctx), b = parseOperand(ops[1], ctx); return wr(a, 2, ea(b)); }
      if (mn === 'les' || mn === 'lds') {
        const a = parseOperand(ops[0], ctx), b = parseOperand(ops[1], ctx), sr = mn === 'les' ? 'es' : 'ds';
        return `t = ${ea(b)}; ${wr(a, 2, `m.rw(${segexpr(b)}, t)`)} r.${sr} = m.rw(${segexpr(b)}, (t + 2) & 0xFFFF);`;
      }
      if (mn === 'push') return `m.push(r, ${rd(parseOperand(ops[0], ctx), 2)});`;
      if (mn === 'pop') return wr(parseOperand(ops[0], ctx), 2, 'm.pop(r)');
      if (ALU.has(mn)) {
        const a = parseOperand(ops[0], ctx), b = parseOperand(ops[1], ctx), sz = opsize(a, b), mask = sz === 1 ? 0xFF : 0xFFFF, A = rd(a, sz), B = rd(b, sz);
        if (['and', 'or', 'xor', 'test'].includes(mn)) {
          const o = { and: '&', test: '&', or: '|', xor: '^' }[mn];
          let s = `t = (${A} ${o} ${B}) & ${mask}; ${flagsLogic('t', sz)}`;
          if (mn !== 'test') s += ' ' + wr(a, sz, 't');
          return s;
        }
        const fn = { add: 'add', adc: 'adc', sub: 'sub', sbb: 'sbb', cmp: 'sub' }[mn];
        let s = `t = m.${fn}${sz * 8}(r, ${A}, ${B});`;
        if (mn !== 'cmp') s += ' ' + wr(a, sz, 't');
        return s;
      }
      if (['inc', 'dec', 'neg', 'not'].includes(mn)) {
        const a = parseOperand(ops[0], ctx), sz = opsize(a);
        if (mn === 'not') return wr(a, sz, '~' + rd(a, sz));
        if (mn === 'neg') return `t = m.neg${sz * 8}(r, ${rd(a, sz)}); ${wr(a, sz, 't')}`;
        return `t = m.${mn}${sz * 8}(r, ${rd(a, sz)}); ${wr(a, sz, 't')}`;
      }
      if (['shl', 'sal', 'shr', 'sar', 'rol', 'ror', 'rcl', 'rcr'].includes(mn)) {
        const a = parseOperand(ops[0], ctx), sz = opsize(a);
        const cnt = ops.length > 1 ? parseOperand(ops[1], ctx) : new Op('imm', { v: 1, size: 1 });
        const C = cnt.kind !== 'imm' ? rd(cnt, 1) : String(cnt.v), op = mn === 'sal' ? 'shl' : mn;
        return `t = m.${op}${sz * 8}(r, ${rd(a, sz)}, ${C} & 31); ${wr(a, sz, 't')}`;
      }
      if (['mul', 'imul', 'div', 'idiv'].includes(mn)) {
        if (ops.length > 1) {
          const a = parseOperand(ops[0], ctx), b = parseOperand(ops[1], ctx), c = ops.length > 2 ? parseOperand(ops[2], ctx) : null;
          return `t = m.imul3(r, ${rd(b, 2)}, ${c ? rd(c, 2) : rd(a, 2)}); ${wr(a, 2, 't')}`;
        }
        const a = parseOperand(ops[0], ctx), sz = opsize(a);
        return `m.${mn}${sz * 8}(r, ${rd(a, sz)});`;
      }
      if (['movsb', 'movsw', 'lodsb', 'lodsw', 'stosb', 'stosw', 'scasb', 'scasw', 'cmpsb', 'cmpsw'].includes(mn)) return `m.str(r, ${J(mn)}, ${prefix ? J(prefix) : 'null'});`;
      if (mn === 'xlat') return 'r.ax = (r.ax & 0xFF00) | m.rb(r.ds, (r.bx + (r.ax & 0xFF)) & 0xFFFF);';
      if (mn === 'loop') return `r.cx = (r.cx - 1) & 0xFFFF; if (r.cx !== 0) { ${jumpTarget(ops[0].split(/\s+/).pop(), ctx)} }`;
      if (has(COND, mn)) {
        const tg = ops[0].split(/\s+/).pop();
        if (tg.startsWith('$+')) return ';';
        return `if (${COND[mn]}) { ${jumpTarget(tg, ctx)} }`;
      }
      if (mn === 'jmp') {
        let tgt = ops[0].trim().replace(/^(short\s+)?((near|far)\s+ptr\s+)?/i, '');
        if (tgt.startsWith('$+')) return ';';
        if (tgt === 'stuntsmain') tgt = 'ported_stuntsmain_';
        if (/^\w+$/.test(tgt) && (has(ctx.labels, tgt) || has(PROCS, tgt) || has(GLABELS, tgt))) return jumpTarget(tgt, ctx);
        const o = parseOperand(ops[0].trim(), ctx);
        if (o.kind === 'mem' && o.table) return `pc = T_${o.table}[(${ea(new Op('mem', { regs: o.regs, disp: 0, seg: 'cs', size: 2 }))}) >> 1]; continue;`;
        if (o.kind === 'mem' && ((o.size || 2) === 4 || ops[0].trim().startsWith('dword'))) return `t = ${ea(o)}; m.jmpfar(r, P, m.rw(${segexpr(o)}, (t + 2) & 0xFFFF), m.rw(${segexpr(o)}, t)); return;`;
        if (o.kind === 'mem') return `m.jmpaddr(r, P, m.rw(${segexpr(o)}, ${ea(o)})); return;`;
        if (o.kind === 'reg') return `m.jmpaddr(r, P, r.${o.r}); return;`;
        throw new Error('indirect jmp ' + tgt);
      }
      if (mn === 'call') {
        let tgt = ops[0].trim();
        if (tgt === 'stuntsmain') tgt = 'ported_stuntsmain_';
        const mm = /^(?:near ptr\s+|far ptr\s+)?(\w+)$/.exec(tgt);
        if (mm && has(PROCS, mm[1])) {
          const callee = PROCS[mm[1]], far = tgt.startsWith('far ptr') || (callee.kind === 'far' && !tgt.startsWith('near ptr'));
          return `m.call(r, P, ${J(mm[1])}, ${far ? 4 : 2});`;
        }
        if (mm && has(GLABELS, mm[1])) { const [pr, idx] = GLABELS[mm[1]]; return `m.call(r, P, ${J(pr)}, ${tgt.startsWith('far ptr') ? 4 : 2}, ${idx});`; }
        const o = parseOperand(tgt, ctx);
        if (o.kind === 'mem') {
          if ((o.size || 2) === 4 || tgt.startsWith('dword')) return `t = ${ea(o)}; m.callfar(r, P, m.rw(${segexpr(o)}, (t + 2) & 0xFFFF), m.rw(${segexpr(o)}, t));`;
          return `m.callptr(r, P, m.rw(${segexpr(o)}, ${ea(o)}), 2);`;
        }
        if (o.kind === 'reg') return `m.callptr(r, P, r.${o.r}, 2);`;
        throw new Error('call ' + tgt);
      }
      if (mn === 'iret') return 'm.iret(r); return;';
      if (['ret', 'retn', 'retf'].includes(mn)) {
        const n = ops.length && ops[0] ? immExpr(ops[0], ctx) : 0;
        const w = (mn === 'retf' || (mn === 'ret' && ctx.proc.kind === 'far')) ? 4 : 2;
        return `m.ret(r, ${w}, ${n}); return;`;
      }
      if (mn === 'leave') return 'r.sp = r.bp; r.bp = m.pop(r);';
      if (mn === 'enter') return `m.push(r, r.bp); r.bp = r.sp; r.sp = (r.sp - ${immExpr(ops[0], ctx)}) & 0xFFFF;`;
      throw new Error('mnemonic ' + mn);
    }
    function translateProc(p) {
      const ctx = { proc: p, locals: {}, labels: {}, tables: {}, cur: 0 };
      const body = [], first = {};
      let pendingTable = null, chain = [];
      const setlocal = (name, val) => { if (!has(first, name)) first[name] = val; body.push(['equ', [name, val]]); };
      for (const raw of p.lines) {
        let l = stripComment(raw), m;
        if (!l.trim()) continue;
        if ((m = /^\s*(\w+)\s*=\s*(\w+)\s+ptr\s+(-?\w+)\s*$/.exec(l))) {
          const t = m[2], tl = t.toLowerCase();
          const sz = SIZES[tl] || (has(STRUCTS, t) ? STRUCTS[t].size : 2);
          setlocal(m[1], [num(m[3].replace(/^-/, '')) * (m[3].startsWith('-') ? -1 : 1), sz, has(STRUCTS, t) ? t : null]);
          continue;
        }
        if ((m = /^\s*(\w+)\s*=\s*(.+)$/.exec(l))) { try { setlocal(m[1], [evalConst(m[2]), 2, null]); } catch (_) {} continue; }
        const ml = /^(\w+)\s+label\s+(near|far|byte|word|dword)\s*$/i.exec(l.trim());
        if (ml) l = ml[1] + ':';
        if ((m = /^(\w+):\s*(.*)$/.exec(l.trim())) && !/^(es|ds|ss|cs)$/i.test(m[1])) {
          ctx.labels[m[1]] = null; body.push(['label', m[1]]);
          l = m[2]; if (!l.trim()) continue;
        }
        let mt = /^(\w+)\s+dw\s+offset\s+(\w+)\s*$/.exec(l.trim());
        if (mt && (has(GLABELS, mt[2]) ? GLABELS[mt[2]][0] : '') !== p.name) mt = null;
        if (mt) {
          chain = pendingTable ? chain.concat([mt[1]]) : [mt[1]];
          ctx.tables[mt[1]] = [];
          for (const tn of chain) ctx.tables[tn].push(mt[2]);
          pendingTable = mt[1]; continue;
        }
        mt = /^dw\s+offset\s+(\w+)\s*$/.exec(l.trim());
        if (mt && pendingTable) { for (const tn of chain) ctx.tables[tn].push(mt[1]); continue; }
        if (/^\s*(db|dw|dd)\b/.test(l.trim()) || /^\w+\s+(db|dw|dd)\b/.test(l.trim())) continue;
        if (/^\s*(assume|smart|nosmart|align|even|public|extrn)\b/i.test(l.trim())) continue;
        pendingTable = null;
        body.push(['ins', l.trim()]);
      }
      let cnum = 1;
      for (const [kind, v] of body) if (kind === 'label') ctx.labels[v] = cnum++;
      const out = [];
      ctx.locals = Object.assign({}, first);
      for (const [kind, v] of body) {
        if (kind === 'equ') { ctx.locals[v[0]] = v[1]; continue; }
        if (kind === 'label') {
          ctx.cur = ctx.labels[v];
          out.push(`    case ${ctx.labels[v]}: /* ${v} */`);
          if (PROBES.has(v)) out.push(`      if (m.probe) m.probe(r, ${J(v)});`);
          continue;
        }
        let js;
        try { js = translateIns(v, ctx); }
        catch (ex) { js = `throw new Error(${J(`untranslated in ${p.name}: ${v} (${ex.plain ? ex.message : "'" + ex.message + "'"})`)});`; }
        out.push('      ' + js + ' // ' + v.split('*/').join(''));
      }
      const tables = Object.entries(ctx.tables).map(([tn, labs]) => `  const T_${tn} = [${labs.map(x => has(ctx.labels, x) ? ctx.labels[x] : -1).join(', ')}];`);
      const src = [`P[${J(p.name)}] = function (r, m, P, entry) {`].concat(tables, ['  let pc = entry || 0, t, a, b, c;', '  for (;;) switch (pc) {', '    case 0:'], out);
      if (p.next) src.push(`      P[${J(p.next)}](r, m, P); return; // runs on into the next proc`);
      src.push('      return; // fell off end', `    default: throw new Error(${J(`bad jump target in ${p.name}: `)} + pc);`, '  }', '};');
      return src.join('\n');
    }

    // ---- data: the data segment and code-segment data, from GAME.EXE plus the map's pointer values
    const DATA = new Uint8Array(MAP.dseg.size);
    DATA.set(IMG.subarray(MAP.dseg.at, Math.min(IMG.length, MAP.dseg.at + MAP.dseg.size)));
    for (const [pos, bytes] of MAP.dseg.fix) DATA.set(bytes, pos);
    const CSBYTES = {};
    for (const [seg, d] of Object.entries(MAP.csdata)) {
      const b = new Uint8Array(d.size);
      for (const [o, a, n] of d.copy) b.set(IMG.subarray(a, a + n), o);
      for (const [o, n, v] of d.fill) b.fill(v, o, o + n);
      for (const [pos, bytes] of d.fix) b.set(bytes, pos);
      CSBYTES[seg] = b;
    }
    const b64 = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return (typeof btoa === 'function' ? btoa(s) : Buffer.from(s, 'latin1').toString('base64')); };

    const procsJs = Object.keys(PROCS).sort().map(n => translateProc(PROCS[n]));
    const errors = procsJs.reduce((n, js) => n + (js.match(/untranslated in/g) || []).length, 0);
    const outp = [];
    outp.push('// Generated in the browser from GAME.EXE by translate.js. Do not edit.');
    outp.push("'use strict';\n(function (root) {\nconst P = {};");
    outp.push(`const DSEG = ${DSEG}, CODESEG = ${CODESEG};`);
    outp.push(`const DSEG_IMAGE = ${J(b64(DATA))};`);
    outp.push(`const SYM = ${J(DSYM)};`);
    outp.push(`const CSDATA = ${J(Object.fromEntries(Object.entries(CSBYTES).map(([k, v]) => [k, b64(v)])))};`);
    outp.push(`const CSYM = ${J(Object.fromEntries(Object.entries(CSDATA).map(([k, v]) => [k, [v[0], v[1]]])))};`);
    outp.push(`const LABELS = ${J(Object.fromEntries(Object.entries(GLABELS).map(([k, v]) => [k, [v[0], v[1], GADDR[k]]])))};`);
    outp.push(`const GLAB = ${J(Object.fromEntries(Object.entries(GADDR).map(([k, v]) => [v, GLABELS[k]])))};`);
    outp.push(`const CODE = ${J(Object.fromEntries(Object.entries(CODE_SYMS).map(([k, v]) => [v, k])))};`);
    outp.push(`const STRUCTS = ${J(Object.fromEntries(Object.entries(STRUCTS).map(([k, v]) => [k, { size: v.size, fields: Object.fromEntries(Object.entries(v.fields).map(([fk, fv]) => [fk, fv[0]])) }])))};`);
    outp.push(procsJs.join('\n'));
    outp.push('root.StuntsCode = { P, DSEG, CODESEG, DSEG_IMAGE, SYM, CODE, GLAB, LABELS, STRUCTS, CSDATA, CSYM };\n})(typeof window !== "undefined" ? window : globalThis);\n');
    return { source: outp.join('\n'), errors, procs: procsJs.length };
  }
  root.StuntsTranslate = translateAll;
  if (typeof module !== 'undefined') module.exports = translateAll;
})(typeof self !== 'undefined' ? self : globalThis);
