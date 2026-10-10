# Dev tool: rebuilds every proc's instructions from the game executable (decoded by x86dec.js, see exedump.js) plus
# names only, translates both that and the disassembly with asm2js, and reports where they differ: what the map that
# ships with the site has to supply beyond the player's own GAME.EXE.
#   python3 tools/mapcheck.py <asmorig dir> <exedump.json> [--show N]
import json, os, re, sys
HERE = os.path.dirname(os.path.abspath(__file__))
ASM, DUMP = sys.argv[1], sys.argv[2]
SHOW = int(sys.argv[sys.argv.index('--show') + 1]) if '--show' in sys.argv else 40

# the translator's state, as it builds gen/code.js (everything before it writes the file)
_src = open(os.path.join(HERE, 'asm2js.py')).read()
_argv = sys.argv; sys.argv = ['asm2js.py', ASM, os.devnull]
G = {'__name__': 'asm2js'}
exec(compile(_src[:_src.index('want = set(sys.argv[3]')], 'asm2js.py', 'exec'), G)
sys.argv = _argv
D = json.load(open(DUMP)); INS = D['ins']; RELOC = set(D['relocs'])
BASE = 0x10000
ADDRNAME = re.compile(r'^(?:loc|sub|locret|byte|word|dword|off|unk|stru|asc|nullsub|j_sub|algn)_([0-9A-F]{4,6})$')
SIZE = {'db': 1, 'dw': 2, 'dd': 4, 'dq': 8, 'dt': 10}
NORM = {'je': 'jz', 'jne': 'jnz', 'jae': 'jnb', 'jnae': 'jb', 'jc': 'jb', 'jnc': 'jnb', 'jna': 'jbe', 'jnbe': 'ja', 'jnge': 'jl', 'jnl': 'jge', 'jng': 'jle', 'jnle': 'jg', 'sal': 'shl', 'ret': 'retn'}

def data_size(kw, rest):
    w = SIZE[kw]; n = 0; items = []; cur = ''; q = None; depth = 0
    for ch in rest:
        if q:
            cur += ch
            if ch == q: q = None
            continue
        if ch in '\'"': q = ch; cur += ch; continue
        if ch == '(': depth += 1
        if ch == ')': depth -= 1
        if ch == ',' and not depth: items.append(cur.strip()); cur = ''
        else: cur += ch
    if cur.strip(): items.append(cur.strip())
    for it in items:
        m = re.match(r'^(\S+)\s+dup\s*\((.*)\)$', it, re.I)
        if m: n += G['num'](m.group(1)) * data_size(kw, m.group(2))
        elif it[:1] in '\'"' and kw == 'db': n += len(it) - 2
        else: n += w
    return n

# ---- addresses: every line of every code file, as the translator splits them
def walk(PINS):
  LINEADDR = {}; LABELADDR = {}
  for fn in sorted(os.listdir(ASM)):
      if not re.match(r'seg\d+\.asm$', fn) or fn == 'seg038.asm': continue
      text = open(os.path.join(ASM, fn), encoding='latin-1').read()
      for a, b in G['FIXUPS'].get(fn, []): text = text.replace(a, b)
      cur = None
      for i, raw in enumerate(text.split('\n')):
          l = G['strip_comment'](raw).rstrip()
          if not l.strip(): continue
          m = re.match(r'^([A-Za-z_@$?][\w@$?]*)\s*(?::|\s+(proc|label|db|dw|dd|dt|dq)\b)', l)
          if m and not re.match(r'^(es|ds|ss|cs)$', m.group(1), re.I):
              a = ADDRNAME.match(m.group(1))
              if a: cur = int(a.group(1), 16) - BASE
              elif m.group(1) in PINS: cur = PINS[m.group(1)]
              if cur is not None: LABELADDR.setdefault(m.group(1), cur)
              rest = l[m.end():].strip() if l[m.end() - 1] == ':' else (m.group(2) + l[m.end():]) if m.group(2) in SIZE else ''
              dm = re.match(r'^(db|dw|dd|dt|dq)\s+(.*)$', rest)
              if dm and cur is not None: LINEADDR[(fn, i)] = cur; cur += data_size(dm.group(1), dm.group(2)); continue
              if not rest.strip(): continue
              l = '    ' + rest
          t = l.strip(); op = t.split()[0].lower()
          if re.match(r'^[\w@$?.]+\s*(=|equ\b)', t, re.I): continue
          if op in ('proc', 'endp', 'assume', 'public', 'extrn', 'include', 'end', 'ends', 'segment', 'label', 'org', 'smart', 'nosmart', 'align', 'even') or re.search(r'\b(segment|ends|endp)\b', t): continue
          if op in SIZE:
              if cur is not None: LINEADDR[(fn, i)] = cur; cur += data_size(op, t[len(op):].strip())
              continue
          if cur is None: continue
          d = INS[cur]
          if op == 'nop' and d[1] != 'nop': continue
          LINEADDR[(fn, i)] = cur; cur += d[0]
  return LINEADDR, LABELADDR
PINS = {}
for _round in range(6):
    LINEADDR, LABELADDR = walk(PINS)
    # a named proc's address, learnt from the code that calls it: the disassembly names the callee, the exe gives
    # where it is
    learnt = 0
    for fn in sorted(os.listdir(ASM)):
        if not re.match(r'seg\d+\.asm$', fn) or fn == 'seg038.asm': continue
        text = open(os.path.join(ASM, fn), encoding='latin-1').read()
        for a_, b_ in G['FIXUPS'].get(fn, []): text = text.replace(a_, b_)
        for i_, raw in enumerate(text.split('\n')):
            a = LINEADDR.get((fn, i_))
            if a is None: continue
            mm = re.match(r'^\s*(?:\w+:\s*)?(call|jmp)\s+(?:short\s+)?(?:(?:near|far)\s+ptr\s+)?(\w+)\s*$', G['strip_comment'](raw))
            if not mm or ADDRNAME.match(mm.group(2)): continue
            d = INS[a]; t = d[3] if d[3] is not None else (d[4][0] * 16 + d[4][1] if d[4] else None)
            if t is not None and mm.group(2) not in PINS: PINS[mm.group(2)] = t; learnt += 1
    if not learnt: break
ADDR2LABEL = {}
for k, v in LABELADDR.items(): ADDR2LABEL.setdefault(v, k)
for name in G['PROCS']:
    if name in LABELADDR: ADDR2LABEL[LABELADDR[name]] = name   # (a proc's own name wins over a label at its start)

# ---- each proc's lines, with the line index in its file
def proc_line_index():
    out = {}
    for fn in sorted(os.listdir(ASM)):
        if not re.match(r'seg\d+\.asm$', fn) or fn == 'seg038.asm': continue
        text = open(os.path.join(ASM, fn), encoding='latin-1').read()
        for a, b in G['FIXUPS'].get(fn, []): text = text.replace(a, b)
        cur = None
        for i, l in enumerate(text.split('\n')):
            m = re.match(r'^(\w+)\s+proc\s*(near|far)?', l)
            if m: cur = m.group(1); out[cur] = []; continue
            if cur and re.match(r'^%s\s+endp\b' % cur, l): cur = None; continue
            if cur: out[cur].append(i)
    return out
PLINES = proc_line_index()
# the proc's own start address: its first instruction line
for name, p in G['PROCS'].items():
    for i in PLINES[name]:
        if (p['file'], i) in LINEADDR: LABELADDR[name] = LINEADDR[(p['file'], i)]; ADDR2LABEL[LABELADDR[name]] = name; break

# ---- segments: each code file's first address, and the paragraph the loader's relocations give it
SEGSTART = {}
for (fn, i), a in LINEADDR.items():
    if fn not in SEGSTART or a < SEGSTART[fn]: SEGSTART[fn] = a
SEGPARA = {}   # file -> its paragraph (from far calls into it: their segment values)
def file_of(a):
    best = None
    for fn, s0 in SEGSTART.items():
        if s0 <= a and (best is None or s0 > SEGSTART[best]): best = fn
    return best
for _a, _d in enumerate(INS):
    if _d[4] and _d[1] in ('call', 'jmp') and any(_a + k in RELOC for k in range(_d[0])):
        _t = _d[4][0] * 16 + _d[4][1]; _f = file_of(_t)
        if _f: SEGPARA.setdefault(_f, _d[4][0])
def seg_of_para(para):
    for fn, pp in SEGPARA.items():
        if pp == para: return fn[:-4]
    for fn, a in SEGSTART.items():
        if para * 16 <= a < para * 16 + 16: return fn[:-4]
    if para * 16 == 0x2B770: return 'dseg'
    return None

# ---- one instruction rebuilt from the executable: decoded text, with targets and segments named
MISSING = []
def rebuild(addr):
    ln, op, args, rel, far, ab = INS[addr]
    args = list(args)
    if rel is not None:
        n = ADDR2LABEL.get(rel)
        if n is None: MISSING.append((addr, 'target %x' % rel)); n = 'loc_%X' % (rel + BASE)
        return op + (' near ptr ' if op == 'call' else ' ') + n
    # a jump through a table in the code segment: the table by name
    if op == 'jmp' and args and 'cs:[' in args[0]:
        fn = file_of(addr); pp = SEGPARA.get(fn, SEGSTART.get(fn, 0) >> 4)
        m = re.match(r'^word ptr cs:\[(\w+)\+(\w+)\]$', args[0])
        if m:
            t = pp * 16 + G['num'](m.group(2)); n = ADDR2LABEL.get(t)
            if n: return 'jmp cs:%s[%s]' % (n, m.group(1))
    if far:
        tgt = far[0] * 16 + far[1]; n = ADDR2LABEL.get(tgt)
        if n is None: MISSING.append((addr, 'far target %x' % tgt)); n = 'loc_%X' % (tgt + BASE)
        return op + ' far ptr ' + n
    # an immediate the loader relocates is a segment
    rel_at = [k for k in range(ln) if addr + k in RELOC]
    if rel_at and args:
        k = rel_at[0]; v = int.from_bytes(bytes(IMG[addr + k:addr + k + 2]), 'little'); sn = seg_of_para(v)
        if sn: args[-1] = 'seg ' + sn
        else: MISSING.append((addr, 'segment %x' % v))
    if op in ('int', 'in', 'out', 'hlt', 'wait'): return (op.ljust(8) + ', '.join(args)).rstrip()   # (as the disassembly spaces them: the emulator gets the text)
    return (op + ' ' + ', '.join(args)).strip()

import base64
IMG = base64.b64decode(D['img'])
def strip_js(js):
    return [re.sub(r' // .*$', '', l) for l in js.split('\n')]
diffs = {}; ndiff = 0; nins = 0; shown = 0
for name, p in G['PROCS'].items():
    newlines = []
    for i, raw in zip(PLINES[name], p['lines']):
        a = LINEADDR.get((p['file'], i))
        l = G['strip_comment'](raw)
        isdata = re.match(r'^\s*(?:\w+\s+)?(db|dw|dd|dt|dq)\b', l)
        if a is None or isdata: newlines.append(raw); continue
        m = re.match(r'^(\s*\w+:\s*)(.*)$', l)
        pre = m.group(1) if m and m.group(2).strip() else ''
        newlines.append(('' if pre else '    ') + pre + rebuild(a))
    q = dict(p); q['lines'] = newlines
    try: A = strip_js(G['translate_proc'](p)); B = strip_js(G['translate_proc'](q))
    except Exception as e: print('fail', name, e); continue
    oa = [l for l in A]; ob = [l for l in B]
    for la, lb, raw in zip(oa, ob, [None] * len(oa)):
        nins += 1
        if la != lb:
            ndiff += 1
            if shown < SHOW: print('%-28s | %s\n%-28s | %s' % (name, la.strip()[:110], '', lb.strip()[:110])); shown += 1
    if len(oa) != len(ob): print('length differs', name, len(oa), len(ob))
print('lines compared', nins, 'differing', ndiff, 'unnamed targets', len(MISSING), MISSING[:8])
