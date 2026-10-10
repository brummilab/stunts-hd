#!/usr/bin/env python3
"""Translate the original Stunts disassembly (Restunts asmorig, TASM syntax, 16-bit real mode)
into JavaScript, instruction for instruction.

Output: one JS module defining
  DSEG_IMAGE   - the data segment's initial bytes (base64), with offsets/pointers relocated
  SYM          - data label -> offset
  PROCS        - name -> function(cpu) translated from the procedure body
The generated code runs against a small CPU/memory runtime (stunts/cpu.js): 16-bit registers,
CF/ZF/SF/OF flags, segment:offset memory, a real stack. Calls push real return-address slots so
[bp+arg] frames line up exactly as in the original.

usage: asm2js.py <asmorig dir> <out.js>
"""
import base64, json, os, re, sys

SRC, OUT = sys.argv[1], sys.argv[2]

def strip_comment(l):
    out, q = '', None
    for ch in l:
        if q:
            out += ch
            if ch == q: q = None
        elif ch in '\'"':
            q = ch; out += ch
        elif ch == ';':
            break
        else:
            out += ch
    return out.rstrip()

def num(tok):
    t = tok.strip()
    if re.fullmatch(r"'.'", t): return ord(t[1])
    if re.fullmatch(r"[0-9][0-9a-fA-F]*[hH]", t): return int(t[:-1], 16)
    if re.fullmatch(r"\d+", t): return int(t)
    if re.fullmatch(r"[01]+[bB]", t): return int(t[:-1], 2)
    return None

# ---------------------------------------------------------------- structs
SIZES = {'byte': 1, 'word': 2, 'dword': 4, 'qword': 8, 'tbyte': 10}
DIRSIZE = {'db': 1, 'dw': 2, 'dd': 4, 'dq': 8, 'dt': 10}
STRUCTS = {}   # name -> {'size': n, 'fields': {member: (offset, elemsize, typename)}}

def parse_structs(text):
    lines = [strip_comment(l) for l in text.split('\n')]
    i = 0
    while i < len(lines):
        m = re.match(r'^\s*(\w+)\s+(struc|union)\b', lines[i])
        if not m: i += 1; continue
        name, kind = m.group(1), m.group(2)
        fields, off, size = {}, 0, 0
        i += 1
        while not re.match(r'^\s*%s\s+ends\b' % name, lines[i]):
            l = lines[i].strip(); i += 1
            if not l: continue
            mm = re.match(r'^(\w+)\s+(db|dw|dd|dq|dt)\s+(.*)$', l)
            if mm:
                es = DIRSIZE[mm.group(2)]
                cnt = 1
                dm = re.match(r'^(\S+)\s+dup', mm.group(3))
                if dm: cnt = num(dm.group(1))
                else:
                    s = mm.group(3).strip()
                    if s[:1] in '\'"' and es == 1: cnt = len(s) - 2
                    else: cnt = max(1, len([x for x in s.split(',') if x.strip()]))
                fields[mm.group(1)] = (off if kind == 'struc' else 0, es, mm.group(2))
                sz = es * cnt
            else:
                mm = re.match(r'^(\w+)\s+(\w+)\s+(?:(\S+)\s+dup\s*)?\(?\s*<.*$', l)
                if not mm: raise Exception('struct line? ' + l)
                t = mm.group(2); cnt = num(mm.group(3)) if mm.group(3) else 1
                fields[mm.group(1)] = (off if kind == 'struc' else 0, STRUCTS[t]['size'], t)
                sz = STRUCTS[t]['size'] * cnt
            if kind == 'struc': off += sz
            else: size = max(size, sz)
        i += 1
        STRUCTS[name] = {'size': off if kind == 'struc' else size, 'fields': fields}

def field_path(path):
    """'CARSTATE.car_posWorld1.lx' -> (offset, size)"""
    parts = path.split('.')
    if parts[0] not in STRUCTS: return None
    st, off, size = parts[0], 0, STRUCTS[parts[0]]['size']
    for p in parts[1:]:
        f = STRUCTS[st]['fields'].get(p)
        if f is None: return None
        off += f[0]
        t = f[2]
        if t in STRUCTS: st = t; size = STRUCTS[t]['size']
        else: size = f[1]; st = None
    return off, size

def member_path(typename, parts):
    st, off, size = typename, 0, None
    for p in parts:
        f = STRUCTS[st]['fields'].get(p)
        if f is None: return None
        off += f[0]; t = f[2]
        if t in STRUCTS: st = t; size = STRUCTS[t]['size']
        else: size = f[1]
    return off, size

# ---------------------------------------------------------------- procs + code labels
PROCS = {}     # name -> dict(kind, lines, file)
CODE_SYMS = {} # proc name -> id
# Places where the disassembly shows code as data. Bytes 83 7E F0 FF 75 03 decode as below.
FIXUPS = {
    # file_decomp_vle addresses its tables by raw code-segment offsets: 421Ch = vle_esc1,
    # 423Ch = vle_esc2, 425Ch = the alphabet right after them (IDA shows 425Ch as callbackflags2+72h)
    'seg012.asm': [('    cmp     ax, offset sprite_set_1_from_argptr', '    cmp     ax, offset wnd_defs_end'),
                   ('    lea     cx, callbackflags2+72h\n', '    mov     cx, offset vle_esc2+32\n'),
                   ('    sub     cx, 425Ch\n', '    sub     cx, offset vle_esc2+32\n'),
                   ('    mov     di, 425Ch\n', '    mov     di, offset vle_esc2+32\n'),
                   ('    cmp     dx, cs:[bp+423Ch]\n', '    cmp     dx, word ptr cs:vle_esc2[bp]\n'),
                   ('    add     dx, cs:[bp+421Ch]\n', '    add     dx, word ptr cs:vle_esc1[bp]\n')],
    # call_read_line passes seg018:0002 as a raw far pointer; offset 2 of seg018 is kb_shift_checking1
    'seg008.asm': [('    mov     ax, 2\n    mov     dx, seg seg018\n', '    mov     ax, offset kb_shift_checking1\n    mov     dx, seg seg018\n')],
    # the race starts with the chase camera (mode 2) and no dashboard; C cycles the cameras, D the dashboard
    'seg005.asm': [('    mov     cameramode, 0\n    mov     game_replay_mode, 1\n', '    mov     cameramode, 2\n    mov     game_replay_mode, 1\n'),
                   ('loc_21C00:\n    mov     cameramode, 0\n', 'loc_21C00:\n    mov     cameramode, 2\n'),
                   ('loc_21C78:\n    mov     cameramode, 0\n    mov     dashb_toggle, 1\n', 'loc_21C78:\n    mov     cameramode, 2\n    mov     dashb_toggle, 0\n'),
                   ('loc_21D2C:\n    mov     cameramode, 0\n', 'loc_21D2C:\n    mov     cameramode, 2\n'),
                   # (and so does "Re-Start Driving" from the Replay Menu)
                   ('loc_244B0:\n    mov     dashb_toggle, 1\n', 'loc_244B0:\n    mov     dashb_toggle, 0\n'),
                   ('    mov     game_replay_mode, 0\n    mov     cameramode, 0\n    mov     state.game_3F6autoLoadEvalFlag, 0\n',
                    '    mov     game_replay_mode, 0\n    mov     cameramode, 2\n    mov     state.game_3F6autoLoadEvalFlag, 0\n')],
    'seg028.asm': [('byte_3930E     db 131\n    db 126\n    db 240\n    push    word ptr [di+3]\n',
                    'byte_3930E:\n    cmp     word ptr [bp-10h], 0FFFFh\n    jnz     loc_39317\n')],
}

def parse_code_files():
    for fn in sorted(os.listdir(SRC)):
        if not re.match(r'seg\d+\.asm$', fn) or fn == 'seg038.asm': continue
        text = open(os.path.join(SRC, fn), encoding='latin-1').read()
        for a, b in FIXUPS.get(fn, []):
            assert a in text, 'fixup not found in ' + fn
            text = text.replace(a, b)
        lines = text.split('\n')
        cur = prev = None; gap_data = False
        for l in lines:
            m = re.match(r'^(\w+)\s+proc\s*(near|far)?', l)
            if m:
                if prev and not gap_data: prev['next'] = m.group(1)   # code running off the end continues here
                cur = {'name': m.group(1), 'kind': m.group(2) or 'near', 'lines': [], 'file': fn}; continue
            if cur and re.match(r'^%s\s+endp\b' % cur['name'], l):
                PROCS[cur['name']] = cur; prev = cur; cur = None; gap_data = False; continue
            if cur is None and re.match(r'^\s*(db|dw|dd)\b|^\w+\s+(db|dw|dd)\b|^\w+:', strip_comment(l)): gap_data = True
            if cur: cur['lines'].append(l)
    for i, name in enumerate(sorted(PROCS)):
        CODE_SYMS[name] = 0x100 + i * 4

# ---------------------------------------------------------------- data segment
DATA = bytearray(); DSYM = {}; DSIZE = {}; DTYPE = {}
CSDATA = {}   # code-segment data: label -> (segment, offset, size)
CSBYTES = {}  # segment -> bytearray

CODESEG = 0xF000
def parse_types(fn):
    for l in open(os.path.join(SRC, fn), encoding='latin-1'):
        m = re.match(r'^\s*extrn\s+(\w+)\s*:\s*(\w+)', l)
        if m and m.group(2) in STRUCTS: DTYPE[m.group(1)] = m.group(2)

# data declared inside code segments (outside procs, or labelled data inside them)
# Code-segment data. Most segments only reach their data by name, so blocks are packed. seg012 also
# uses raw offsets (sprite line tables at 5F5Ch, the VLE tables at 421Ch), so its data is placed at the
# original offsets: segment base 2EA20h (counted from the first instructions of file_decomp_vle), block
# positions from IDA's address-named labels (linear addresses) or the pinned tables below.
SEGBASE = {'seg012.asm': 0x2EA20}
# labels where the host can observe the original mid-procedure (see hires-capture.js)
PROBES = {'loc_25801', 'loc_250A3'}   # loc_250A3: matrices ready, before any primitive   # transformed_shape_op: end of one primitive, [bp-4] = it was drawn
PINS = {'vle_esc1': 0x421C, 'lineoffsets': 0x5F5C}
ADDRNAME = re.compile(r'^(?:loc|sub|word|byte|dword|off|unk|locret|stru|nullsub|nopsub)_([0-9A-F]{5})$')

def code_data_bytes(m, fn):
    w = DIRSIZE[m.group(2).lower()]
    buf, refs = bytearray(), []
    for it in re.split(r',(?![^(]*\))', m.group(3)):
        it = it.strip()
        dm = re.match(r'^(\S+)\s+dup\s*\((.*)\)$', it, re.I)
        if dm:
            n = num(dm.group(1)) or 0; v = num(dm.group(2)) or 0
            for _ in range(n): buf.extend((v & ((1 << 8 * w) - 1)).to_bytes(w, 'little'))
        elif it[:1] in '\'"' and w == 1: buf.extend(it[1:-1].encode('latin-1'))
        else:
            v = num(it)
            if v is None:
                mm = re.match(r'^(offset\s+)?(\w+)$', it)
                n_ = mm.group(2) if mm else None
                if n_ in DSYM: v, sg = DSYM[n_], DSEG
                elif n_ in CODE_SYMS: v, sg = CODE_SYMS[n_], CODESEG
                elif n_ in GADDR: v, sg = GADDR[n_], CODESEG
                else:
                    v, sg = 0, 0   # code-segment data: patched once the layout is known
                    if n_: refs.append((len(buf), w, n_, bool(mm and mm.group(1))))
                if w == 4 and not (mm and mm.group(1)): v |= sg << 16   # far pointer
            buf.extend((v & ((1 << 8 * w) - 1)).to_bytes(w, 'little'))
    return w, buf, refs

CSREFS = []   # (segment, offset, width, symbol, is 'offset X', file) pointers to code-segment data

def parse_code_data():
    for idx, fn in enumerate(sorted(os.listdir(SRC))):
        if not re.match(r'seg\d+\.asm$', fn): continue
        segval = 0x9000 + idx * 0x100
        blocks, cur = [], None
        for l in open(os.path.join(SRC, fn), encoding='latin-1'):
            c = strip_comment(l); cs = c.strip()
            if not cs: continue
            m = re.match(r'^(?:(\w+)\s+)?(db|dw|dd)\s+(.*)$', cs, re.I)
            if m:
                if cur is None: cur = {'items': [], 'after': None}; blocks.append(cur)
                w, data, refs = code_data_bytes(m, fn)
                cur['items'].append((m.group(1), w, data, refs)); continue
            if re.match(r'^(public|extrn|include|assume|\.model|smart|nosmart|align|even)\b', cs, re.I) or re.match(r'^\w+\s*=', cs): continue
            if cur is not None:
                ml = re.match(r'^(\w+)(?::|\s+(?:proc|label)\b)', c)
                a = ADDRNAME.match(ml.group(1)) if ml else None
                if a: cur['after'] = int(a.group(1), 16)
                cur = None
        total = lambda b: sum(len(d) for _, _, d, _ in b['items'])
        base = SEGBASE.get(fn)
        end = 0
        for b in blocks:
            b['off'] = None
            if base is None: continue
            pos = 0
            for name, _, data, _ in b['items']:
                a = ADDRNAME.match(name) if name else None
                if name in PINS: b['off'] = PINS[name] - pos; break
                if a: b['off'] = int(a.group(1), 16) - base - pos; break
                pos += len(data)
            if b['off'] is None and b['after'] is not None: b['off'] = b['after'] - base - total(b)
        placed = sorted((b['off'], b['off'] + total(b)) for b in blocks if b['off'] is not None)
        for (s0, e0), (s1, e1) in zip(placed, placed[1:]):
            if s1 < e0: print('code data overlap in', fn, hex(s0), hex(e0), hex(s1), [[(n, len(d)) for n, _, d, _ in b['items']][:3] for b in blocks if b['off'] in (s0, s1)])
        end = max([e for _, e in placed] + [0])
        for b in blocks:
            if b['off'] is None: b['off'] = end; end += total(b)
        buf = CSBYTES.setdefault(segval, bytearray(end))
        for b in blocks:
            pos = b['off']
            for name, w, data, refs in b['items']:
                if name: CSDATA[name] = (segval, pos, w)
                buf[pos:pos + len(data)] = data
                for rp, rw, rn, isoff in refs: CSREFS.append((segval, pos + rp, rw, rn, isoff, fn))
                pos += len(data)
            if any(n == 'wnd_defs' for n, _, _, _ in b['items']): CSDATA['wnd_defs_end'] = (segval, pos, 1)

def parse_data(fn):
    lines = open(os.path.join(SRC, fn), encoding='latin-1').read().split('\n')
    st = next(i for i, l in enumerate(lines) if l.startswith('dseg segment'))
    en = next(i for i, l in enumerate(lines) if l.startswith('dseg ends'))
    pending = []   # (pos, width, expr) to resolve after all labels known
    def split_items(s):
        out, cur, q, depth = [], '', None, 0
        for ch in s:
            if q:
                cur += ch
                if ch == q: q = None
            elif ch in '\'"': q = ch; cur += ch
            elif ch == '(': depth += 1; cur += ch
            elif ch == ')': depth -= 1; cur += ch
            elif ch == ',' and depth == 0: out.append(cur); cur = ''
            else: cur += ch
        if cur.strip(): out.append(cur)
        return out
    def emit(item, w):
        item = item.strip()
        m = re.match(r'^(\S+)\s+dup\s*\((.*)\)$', item, re.I)
        if m:
            for _ in range(num(m.group(1))):
                for sub in split_items(m.group(2)): emit(sub, w)
            return
        if item[:1] in '\'"' and w == 1:
            DATA.extend(item[1:-1].encode('latin-1')); return
        v = num(item)
        if v is None and item == '?': v = 0
        if v is None:
            pending.append((len(DATA), w, item)); v = 0
        DATA.extend((v & ((1 << (8 * w)) - 1)).to_bytes(w, 'little'))
    for l in lines[st + 1:en]:
        c = strip_comment(l)
        if not c.strip(): continue
        m = re.match(r"^\s*(?:(\w+)\s+)?(db|dw|dd)\s+(.*)$", c, re.I)
        if m:
            if m.group(1): DSYM[m.group(1)] = len(DATA); DSIZE[m.group(1)] = DIRSIZE[m.group(2).lower()]
            for it in split_items(m.group(3)): emit(it, DIRSIZE[m.group(2).lower()])
    DATA_PENDING.extend(pending)   # resolved after the code-segment data is laid out

DATA_PENDING = []
def resolve_data():
    for pos, w, expr in DATA_PENDING:
        v = data_expr(expr, w)
        DATA[pos:pos + w] = (v & ((1 << (8 * w)) - 1)).to_bytes(w, 'little')

DSEG = 0x1000   # paragraph where the data segment lives in emulated memory
def sym_value(name):
    if name in DSYM: return DSYM[name], DSEG
    if name in CODE_SYMS: return CODE_SYMS[name], CODESEG
    if name in CSDATA: return CSDATA[name][1], CSDATA[name][0]
    if name.lower() == 'dseg': return 0, DSEG
    if name + '.asm' in CODESEG_OF: return 0, CODESEG_OF[name + '.asm']
    return None

def data_expr(expr, w):
    e = expr.strip()
    m = re.match(r'^offset\s+(.+)$', e)
    if m: e = m.group(1)
    m = re.match(r'^seg\s+(\w+)$', e)
    if m:
        sv = sym_value(m.group(1)); return sv[1] if sv else 0
    # label [+/- n], possibly struct field (label.field)
    m = re.match(r'^(\w+)((?:\.\w+)*)\s*([+-]\s*[\w]+)?$', e)
    if m:
        sv = sym_value(m.group(1))
        if sv:
            off = sv[0]
            if m.group(2):
                fp = field_path(m.group(2)[1:].split('.')[0] and None or '') if False else None
            if m.group(3):
                n = num(m.group(3)[1:].strip())
                off += n if m.group(3).strip()[0] == '+' else -n
            return off if w == 2 else (sv[1] << 16) | (off & 0xFFFF)
    try:
        return eval_const(e)
    except Exception:
        sys.stderr.write('unresolved data expr: %r\n' % expr)
        return 0

CONSTS = {}
def parse_consts():
    for fn in sorted(os.listdir(SRC)):
        if not (fn.endswith('.inc') or fn.endswith('.asm')): continue
        inproc = False
        for l in open(os.path.join(SRC, fn), encoding='latin-1'):
            c = strip_comment(l)
            if re.match(r'^\w+\s+proc\b', c): inproc = True
            if re.match(r'^\w+\s+endp\b', c): inproc = False
            if inproc: continue
            m = re.match(r'^\s*(\w+)\s+(?:equ|=)\s+(.+)$', c) or re.match(r'^\s*(\w+)\s*=\s*(.+)$', c)
            if m:
                v = num(m.group(2).strip())
                if v is not None: CONSTS[m.group(1)] = v
            m = re.match(r'^\s*(\w+)\s+enum\s+(.*)$', c)
            if m:
                k = 0
                for part in re.split(r'\s*,\s*', m.group(2).strip('{} ')):
                    if not part: continue
                    nm, _, val = part.partition(':')
                    if val: k = num(val.strip())
                    CONSTS[nm.strip()] = k; k += 1

def eval_const(e):
    """Constant expression: numbers, struct paths, size X, + - * / ( )."""
    def repl(m):
        t = m.group(0)
        v = num(t)
        if v is not None: return str(v)
        fp = field_path(t)
        if fp: return str(fp[0])
        if t in STRUCTS: return str(STRUCTS[t]['size'])
        if t in CONSTS: return str(CONSTS[t])
        raise ValueError(t)
    e2 = re.sub(r'\bsize\s+(\w+)', lambda m: str(STRUCTS[m.group(1)]['size']), e)
    e2 = re.sub(r"'.'|[A-Za-z_]\w*(?:\.\w+)*|[0-9][0-9a-fA-F]*[hH]|\d+", repl, e2)
    return int(eval(e2.replace('/', '//')))

# ---------------------------------------------------------------- operand model
REG16 = ['ax', 'cx', 'dx', 'bx', 'sp', 'bp', 'si', 'di']
REG8 = {'al': ('ax', 0), 'ah': ('ax', 8), 'bl': ('bx', 0), 'bh': ('bx', 8), 'cl': ('cx', 0), 'ch': ('cx', 8), 'dl': ('dx', 0), 'dh': ('dx', 8)}
SREG = ['es', 'cs', 'ss', 'ds']

class Op:
    def __init__(self, kind, **kw):
        self.kind = kind; self.__dict__.update(kw)

class Ctx:
    def __init__(self, proc):
        self.proc = proc; self.locals = {}; self.labels = {}; self.tables = {}; self.cur = 0

def parse_operand(s, ctx):
    s = s.strip()
    size = None
    m = re.match(r'^(byte|word|dword)\s+ptr\s+(.*)$', s, re.I)
    if m: size = SIZES[m.group(1).lower()]; s = m.group(2).strip()
    m = re.match(r'^(near|far)\s+ptr\s+(.*)$', s, re.I)
    if m: s = m.group(2).strip()
    low = s.lower()
    if low in REG16: return Op('reg', r=low, size=2)
    if low in REG8: return Op('reg8', r=REG8[low][0], sh=REG8[low][1], size=1)
    if low == 'cs' and ctx is not None: return Op('imm', v=CODESEG_OF.get(ctx.proc['file'], CODESEG), size=2)
    if low in SREG: return Op('sreg', r=low, size=2)
    seg = None
    m = re.match(r'^(es|ds|ss|cs):(.*)$', s, re.I)
    if m: seg = m.group(1).lower(); s = m.group(2).strip()
    # immediate?
    if '[' not in s and not seg:
        try:
            return Op('imm', v=imm_expr(s, ctx), size=size)
        except (KeyError, ValueError, SyntaxError):
            pass
    # memory: collect base/index registers, displacement terms, symbols
    s = re.sub(r'\bsize\s+(\w+)', lambda mm: str(STRUCTS[mm.group(1)]['size']), s)
    # flatten '(a+b)[bx]' style terms: parenthesised groups that are only added
    s = re.sub(r'(^|\+)\s*\(([^()]*)\)', lambda mm: mm.group(1) + mm.group(2), s)
    expr = s.replace('[', '+').replace(']', '')
    regs, disp, sym, esize, symseg = [], 0, None, None, None
    toks = re.findall(r'[+-]?\s*(?:\([^)]*\)|[\w.\']+)', expr)
    for t in toks:
        sign = -1 if t.strip().startswith('-') else 1
        t = t.strip().lstrip('+-').strip()
        if not t: continue
        if t.startswith('('):
            disp += sign * imm_expr(t[1:-1], ctx); continue
        tl = t.lower()
        if tl in ('bx', 'bp', 'si', 'di'): regs.append(tl); continue
        v = num(t)
        if v is not None: disp += sign * v; continue
        base = t.split('.')[0]
        rest = t.split('.')[1:]
        if base in ctx.locals:
            off, tsz, tname = ctx.locals[base]
            disp += sign * off
            if rest:
                mp = member_path(tname, rest); disp += sign * mp[0]; esize = esize or mp[1]
            else:
                esize = esize or tsz
            continue
        fp = field_path(t)
        if fp:
            disp += sign * fp[0]; esize = esize or fp[1]; continue
        if base in DSYM:
            sym = base; disp += sign * DSYM[base]
            if rest:
                mp = member_path(DTYPE[base], rest); disp += sign * mp[0]; esize = esize or mp[1]
            else:
                esize = esize or DSIZE.get(base)
            continue
        if base in ctx.tables:
            sym = base; symseg = 'cs'; esize = 2; continue
        if base in CSDATA:
            segv, off, w = CSDATA[base]
            sym = base; symseg = 'const:%d' % segv; disp += sign * off
            if rest:
                mp = member_path(CSTYPE.get(base), rest); disp += sign * mp[0]; esize = esize or mp[1]
            else: esize = esize or w
            continue
        if base in ctx.tables:
            sym = base; symseg = 'cs'; disp += 0; esize = 2; continue
        if base in STRUCTS:
            disp += sign * STRUCTS[base]['size']; continue
        if base in CONSTS:
            disp += sign * CONSTS[base]; continue
        if base in CODE_SYMS:
            disp += sign * CODE_SYMS[base]; continue
        raise KeyError('unknown symbol ' + t)
    if symseg and symseg.startswith('const:'):
        seg = symseg   # data living in a code segment: fixed segment value
    if not seg:
        seg = 'ss' if 'bp' in regs else ('cs' if symseg == 'cs' else 'ds')
    if seg == 'cs' and symseg != 'cs':
        seg = 'const:%d' % CODESEG_OF.get(ctx.proc['file'], 0)
    return Op('mem', regs=regs, disp=disp, seg=seg, size=size or esize, table=sym if symseg == 'cs' else None)

def imm_expr(s, ctx):
    s = s.strip()
    while s.startswith('(') and s.endswith(')') and s.count('(') == 1: s = s[1:-1].strip()
    m = re.match(r'^offset\s+(.*)$', s, re.I)
    if m:
        t = m.group(1).strip()
        mm = re.match(r'^(\w+)((?:\.\w+)*)\s*([+-].*)?$', t)
        if not mm: raise KeyError('offset expr ' + t)
        base = mm.group(1); extra = mm.group(3)
        dotted = mm.group(2)[1:].split('.') if mm.group(2) else []
        if base in DSYM:
            v = DSYM[base]
            if dotted: v += member_path(DTYPE[base], dotted)[0]
        elif base in CSDATA: v = CSDATA[base][1]
        elif base in CODE_SYMS: v = CODE_SYMS[base]
        elif base in ctx.labels: v = 0x8000 + ctx.labels[base]
        elif base in GADDR: v = GADDR[base]
        else:
            fp = field_path(t)
            if fp: return fp[0]
            raise KeyError('offset of ' + t)
        if extra: v += eval_const(extra) if extra[0] != '+' else eval_const(extra[1:])
        return v & 0xFFFF
    m = re.match(r'^seg\s+(\w+)$', s, re.I)
    if m:
        n = m.group(1)
        if n in DSYM or n.lower() == 'dseg': return DSEG
        if n in CSDATA: return CSDATA[n][0]
        if n + '.asm' in CODESEG_OF: return CODESEG_OF[n + '.asm']
        if n in PROCS: return CODESEG_OF.get(PROCS[n]['file'], CODESEG)
        return CODESEG
    if s in ctx.locals: return ctx.locals[s][0]
    if s in DSYM: raise KeyError('symbol used as immediate: ' + s)
    return eval_const(s)

# ---------------------------------------------------------------- code generation
def ea(op):
    parts = ['r.' + x for x in op.regs]
    if op.disp: parts.append(str(op.disp & 0xFFFF))
    e = ' + '.join(parts) if parts else '0'
    return '((%s) & 0xFFFF)' % e

def rd(op, size):
    if op.kind == 'reg': return 'r.' + op.r
    if op.kind == 'reg8': return '((r.%s >> %d) & 0xFF)' % (op.r, op.sh) if op.sh else '(r.%s & 0xFF)' % op.r
    if op.kind == 'sreg': return 'r.' + op.r
    if op.kind == 'imm': return str(op.v & (0xFF if size == 1 else 0xFFFF if size == 2 else 0xFFFFFFFF))
    fn = {1: 'rb', 2: 'rw', 4: 'rd'}[size]
    return 'm.%s(%s, %s)' % (fn, segexpr(op), ea(op))

def wr(op, size, val):
    if op.kind == 'reg': return 'r.%s = (%s) & 0xFFFF;' % (op.r, val)
    if op.kind == 'reg8':
        if op.sh: return 'r.%s = (r.%s & 0x00FF) | (((%s) & 0xFF) << 8);' % (op.r, op.r, val)
        return 'r.%s = (r.%s & 0xFF00) | ((%s) & 0xFF);' % (op.r, op.r, val)
    if op.kind == 'sreg': return 'r.%s = (%s) & 0xFFFF;' % (op.r, val)
    fn = {1: 'wb', 2: 'ww', 4: 'wd'}[size]
    return 'm.%s(%s, %s, %s);' % (fn, segexpr(op), ea(op), val)

def segexpr(op):
    return op.seg[6:] if op.seg.startswith('const:') else 'r.' + op.seg

def opsize(a, b=None, default=2):
    for o in (a, b):
        if o is not None and o.kind in ('reg', 'reg8', 'sreg') : return o.size
    for o in (a, b):
        if o is not None and o.kind == 'mem' and o.size: return o.size
    for o in (a, b):
        if o is not None and o.kind == 'imm' and o.size: return o.size
    return default

COND = {
    'jz': 'r.zf', 'je': 'r.zf', 'jnz': '!r.zf', 'jne': '!r.zf',
    'jl': '(!r.sf !== !r.of)', 'jnge': '(!r.sf !== !r.of)', 'jge': '(!r.sf === !r.of)', 'jnl': '(!r.sf === !r.of)',
    'jle': '(r.zf || !r.sf !== !r.of)', 'jng': '(r.zf || !r.sf !== !r.of)', 'jg': '(!r.zf && !r.sf === !r.of)', 'jnle': '(!r.zf && !r.sf === !r.of)',
    'jb': 'r.cf', 'jc': 'r.cf', 'jnae': 'r.cf', 'jnb': '!r.cf', 'jae': '!r.cf', 'jnc': '!r.cf',
    'jbe': '(r.cf || r.zf)', 'jna': '(r.cf || r.zf)', 'ja': '(!r.cf && !r.zf)', 'jnbe': '(!r.cf && !r.zf)',
    'js': 'r.sf', 'jns': '!r.sf', 'jo': 'r.of', 'jno': '!r.of', 'jp': 'r.pf', 'jnp': '!r.pf', 'jpe': 'r.pf', 'jpo': '!r.pf',
    'jcxz': '(r.cx === 0)',
}
ALU = {'add', 'adc', 'sub', 'sbb', 'cmp', 'and', 'or', 'xor', 'test'}

def translate_proc(p):
    ctx = Ctx(p)
    # pass 1: locals, labels, in-code tables
    body = []
    pending_table = None; chain = []
    # '=' equates are redefinable and apply from where they appear (a proc holding several IDA
    # functions redefines arg_2 etc. further down), so they go into the body in order; a name used
    # before its first definition gets that first value
    first = {}
    def setlocal(name, val):
        first.setdefault(name, val); body.append(('equ', (name, val)))
    for raw in p['lines']:
        l = strip_comment(raw)
        if not l.strip(): continue
        m = re.match(r'^\s*(\w+)\s*=\s*(\w+)\s+ptr\s+(-?\w+)\s*$', l)
        if m:
            t = m.group(2); tl = t.lower()
            sz = SIZES.get(tl) or (STRUCTS[t]['size'] if t in STRUCTS else 2)
            setlocal(m.group(1), (num(m.group(3).lstrip('-')) * (-1 if m.group(3).startswith('-') else 1), sz, t if t in STRUCTS else None))
            continue
        m = re.match(r'^\s*(\w+)\s*=\s*(.+)$', l)
        if m:
            try: setlocal(m.group(1), (eval_const(m.group(2)), 2, None))
            except Exception: pass
            continue
        ml = re.match(r'^(\w+)\s+label\s+(near|far|byte|word|dword)\s*$', l.strip(), re.I)
        if ml: l = ml.group(1) + ':'
        m = re.match(r'^(\w+):\s*(.*)$', l.strip())
        if m and not re.match(r'^(es|ds|ss|cs)$', m.group(1), re.I):
            ctx.labels[m.group(1)] = None; body.append(('label', m.group(1)))
            l = m.group(2)
            if not l.strip(): continue
        mt = re.match(r'^(\w+)\s+dw\s+offset\s+(\w+)\s*$', l.strip())
        if mt and GLABELS.get(mt.group(2), ('',))[0] != p['name']: mt = None   # data pointer, not a jump table
        if mt:
            # IDA sometimes names entries inside a table (off_24D20, off_24D22, ...): a named entry right
            # after another table entry continues every table of that run
            chain = (chain + [mt.group(1)]) if pending_table else [mt.group(1)]
            ctx.tables[mt.group(1)] = []
            for t in chain: ctx.tables[t].append(mt.group(2))
            pending_table = mt.group(1); continue
        mt = re.match(r'^dw\s+offset\s+(\w+)\s*$', l.strip())
        if mt and pending_table:
            for t in chain: ctx.tables[t].append(mt.group(1))
            continue
        if re.match(r'^\s*(db|dw|dd)\b', l.strip()) or re.match(r'^\w+\s+(db|dw|dd)\b', l.strip()):
            continue  # other in-code data (alignment etc.)
        if re.match(r'^\s*(assume|smart|nosmart|align|even|public|extrn)\b', l.strip(), re.I): continue
        pending_table = None
        body.append(('ins', l.strip()))
    # number labels
    case = 1
    for kind, v in body:
        if kind == 'label': ctx.labels[v] = case; case += 1
    out = []
    E = out.append
    rep = None
    ctx.locals = dict(first)
    for kind, v in body:
        if kind == 'equ':
            ctx.locals[v[0]] = v[1]; continue
        if kind == 'label':
            ctx.cur = ctx.labels[v]
            E('    case %d: /* %s */' % (ctx.labels[v], v))
            if v in PROBES: E('      if (m.probe) m.probe(r, %s);' % json.dumps(v))
            continue
        try:
            js = translate_ins(v, ctx)
        except Exception as ex:
            js = 'throw new Error(%s);' % json.dumps('untranslated in %s: %s (%s)' % (p['name'], v, ex))
        E('      ' + js + ' // ' + v.replace('*/', ''))
    tables = []
    for tname, labs in ctx.tables.items():
        tables.append('  const T_%s = [%s];' % (tname, ', '.join(str(ctx.labels.get(x, -1)) for x in labs)))
    src = ['P[%s] = function (r, m, P, entry) {' % json.dumps(p['name'])]
    src += tables
    src += ['  let pc = entry || 0, t, a, b, c;', '  for (;;) switch (pc) {', '    case 0:']
    src += out
    if p.get('next'): src += ['      P[%s](r, m, P); return; // runs on into the next proc' % json.dumps(p['next'])]
    src += ['      return; // fell off end', '    default: throw new Error(%s + pc);' % json.dumps('bad jump target in %s: ' % p['name']), '  }', '};']
    return '\n'.join(src)

def jump_target(name, ctx):
    if name in ctx.labels:
        if ctx.labels[name] <= ctx.cur: return 'if (--m.budget < 0) m.poll(r, P); pc = %d; continue;' % ctx.labels[name]
        return 'pc = %d; continue;' % ctx.labels[name]
    if name == ctx.proc['name']: return 'if (--m.budget < 0) m.poll(r, P); pc = 0; continue;'
    if name in PROCS:   # tail jump into another proc
        return 'P[%s](r, m, P); return;' % json.dumps(name)
    if name in GLABELS:  # jump into the middle of another proc (IDA function chunks)
        pr, idx = GLABELS[name]
        return 'P[%s](r, m, P, %d); return;' % (json.dumps(pr), idx)
    raise KeyError('jump target ' + name)

def flags_logic(res, size):
    mask = 0xFF if size == 1 else 0xFFFF
    sb = 0x80 if size == 1 else 0x8000
    return 'r.cf = 0; r.of = false; r.zf = ((%s) & %d) === 0; r.sf = ((%s) & %d) !== 0;' % (res, mask, res, sb)

def translate_ins(text, ctx):
    t = text
    prefix = None
    m = re.match(r'^(rep|repe|repz|repne|repnz)\s+(.*)$', t, re.I)
    if m: prefix = m.group(1).lower(); t = m.group(2).strip()
    m = re.match(r'^(\w+)\s*(.*)$', t)
    mn, rest = m.group(1).lower(), m.group(2).strip()
    ops = split_ops(rest)
    if mn in ('nop', 'cld', 'std', 'cli', 'sti', 'smart', 'nosmart'):
        if mn == 'cld': return 'r.df = 0;'
        if mn == 'std': return 'r.df = 1;'
        return ';'
    if mn == 'clc': return 'r.cf = 0;'
    if mn == 'stc': return 'r.cf = 1;'
    if mn == 'cmc': return 'r.cf = r.cf ? 0 : 1;'
    if mn == 'cbw': return 'r.ax = ((r.ax & 0x80) ? 0xFF00 : 0) | (r.ax & 0xFF);'
    if mn == 'cwd': return 'r.dx = (r.ax & 0x8000) ? 0xFFFF : 0;'
    if mn == 'lahf': return 'r.ax = (r.ax & 0xFF) | ((r.sf ? 0x80 : 0) | (r.zf ? 0x40 : 0) | (r.cf ? 1 : 0) | 2) << 8;'
    if mn == 'sahf': return 't = r.ax >> 8; r.sf = !!(t & 0x80); r.zf = !!(t & 0x40); r.cf = t & 1;'
    if mn == 'pushf': return 'm.push(r, (r.cf ? 1 : 0) | (r.zf ? 0x40 : 0) | (r.sf ? 0x80 : 0) | (r.of ? 0x800 : 0) | (r.df ? 0x400 : 0) | 2);'
    if mn == 'popf': return 't = m.pop(r); r.cf = t & 1; r.zf = !!(t & 0x40); r.sf = !!(t & 0x80); r.of = !!(t & 0x800); r.df = (t >> 10) & 1;'
    if mn in ('in', 'out', 'int', 'hlt', 'wait'): return 'm.io(r, %s);' % json.dumps(text)
    if mn == 'mov':
        a, b = parse_operand(ops[0], ctx), parse_operand(ops[1], ctx)
        sz = opsize(a, b)
        return wr(a, sz, rd(b, sz))
    if mn == 'xchg':
        a, b = parse_operand(ops[0], ctx), parse_operand(ops[1], ctx)
        sz = opsize(a, b)
        return 't = %s; %s %s' % (rd(a, sz), wr(a, sz, rd(b, sz)), wr(b, sz, 't'))
    if mn == 'lea':
        a, b = parse_operand(ops[0], ctx), parse_operand(ops[1], ctx)
        return wr(a, 2, ea(b))
    if mn in ('les', 'lds'):
        a, b = parse_operand(ops[0], ctx), parse_operand(ops[1], ctx)
        sr = 'es' if mn == 'les' else 'ds'
        return 't = %s; %s r.%s = m.rw(%s, (t + 2) & 0xFFFF);' % (ea(b), wr(a, 2, 'm.rw(%s, t)' % segexpr(b)), sr, segexpr(b))
    if mn == 'push':
        a = parse_operand(ops[0], ctx)
        return 'm.push(r, %s);' % rd(a, 2)
    if mn == 'pop':
        a = parse_operand(ops[0], ctx)
        return wr(a, 2, 'm.pop(r)')
    if mn in ALU:
        a, b = parse_operand(ops[0], ctx), parse_operand(ops[1], ctx)
        sz = opsize(a, b)
        mask = 0xFF if sz == 1 else 0xFFFF
        A, B = rd(a, sz), rd(b, sz)
        if mn in ('and', 'or', 'xor', 'test'):
            o = {'and': '&', 'test': '&', 'or': '|', 'xor': '^'}[mn]
            s = 't = (%s %s %s) & %d; %s' % (A, o, B, mask, flags_logic('t', sz))
            if mn != 'test': s += ' ' + wr(a, sz, 't')
            return s
        fn = {'add': 'add', 'adc': 'adc', 'sub': 'sub', 'sbb': 'sbb', 'cmp': 'sub'}[mn]
        s = 't = m.%s%d(r, %s, %s);' % (fn, sz * 8, A, B)
        if mn != 'cmp': s += ' ' + wr(a, sz, 't')
        return s
    if mn in ('inc', 'dec', 'neg', 'not'):
        a = parse_operand(ops[0], ctx); sz = opsize(a)
        if mn == 'not': return wr(a, sz, '~%s' % rd(a, sz))
        if mn == 'neg': return 't = m.neg%d(r, %s); %s' % (sz * 8, rd(a, sz), wr(a, sz, 't'))
        return 't = m.%s%d(r, %s); %s' % (mn, sz * 8, rd(a, sz), wr(a, sz, 't'))
    if mn in ('shl', 'sal', 'shr', 'sar', 'rol', 'ror', 'rcl', 'rcr'):
        a = parse_operand(ops[0], ctx); sz = opsize(a)
        cnt = parse_operand(ops[1], ctx) if len(ops) > 1 else Op('imm', v=1, size=1)
        C = rd(cnt, 1) if cnt.kind != 'imm' else str(cnt.v)
        op = 'shl' if mn == 'sal' else mn
        return 't = m.%s%d(r, %s, %s & 31); %s' % (op, sz * 8, rd(a, sz), C, wr(a, sz, 't'))
    if mn in ('mul', 'imul', 'div', 'idiv'):
        if len(ops) > 1:   # 186 imul reg, r/m, imm
            a = parse_operand(ops[0], ctx); b = parse_operand(ops[1], ctx)
            c = parse_operand(ops[2], ctx) if len(ops) > 2 else None
            return 't = m.imul3(r, %s, %s); %s' % (rd(b, 2), rd(c, 2) if c else rd(a, 2), wr(a, 2, 't'))
        a = parse_operand(ops[0], ctx); sz = opsize(a)
        return 'm.%s%d(r, %s);' % (mn, sz * 8, rd(a, sz))
    if mn in ('movsb', 'movsw', 'lodsb', 'lodsw', 'stosb', 'stosw', 'scasb', 'scasw', 'cmpsb', 'cmpsw'):
        return 'm.str(r, %s, %s);' % (json.dumps(mn), json.dumps(prefix))
    if mn == 'xlat':
        return 'r.ax = (r.ax & 0xFF00) | m.rb(r.ds, (r.bx + (r.ax & 0xFF)) & 0xFFFF);'
    if mn == 'loop':
        return 'r.cx = (r.cx - 1) & 0xFFFF; if (r.cx !== 0) { %s }' % jump_target(ops[0].split()[-1], ctx)
    if mn in COND:
        tg = ops[0].split()[-1]
        if tg.startswith('$+'): return ';'
        return 'if (%s) { %s }' % (COND[mn], jump_target(tg, ctx))
    if mn == 'jmp':
        tgt = re.sub(r'^(short\s+)?((near|far)\s+ptr\s+)?', '', ops[0].strip(), flags=re.I)
        if tgt.startswith('$+'): return ';'
        if tgt == 'stuntsmain': tgt = 'ported_stuntsmain_'
        if re.match(r'^\w+$', tgt) and (tgt in ctx.labels or tgt in PROCS or tgt in GLABELS): return jump_target(tgt, ctx)
        o = parse_operand(ops[0].strip(), ctx)
        if o.kind == 'mem' and o.table:
            return 'pc = T_%s[(%s) >> 1]; continue;' % (o.table, ea(Op('mem', regs=o.regs, disp=0, seg='cs', size=2)))
        if o.kind == 'mem' and ((o.size or 2) == 4 or ops[0].strip().startswith('dword')): return 't = %s; m.jmpfar(r, P, m.rw(%s, (t + 2) & 0xFFFF), m.rw(%s, t)); return;' % (ea(o), segexpr(o), segexpr(o))
        if o.kind == 'mem': return 'm.jmpaddr(r, P, m.rw(%s, %s)); return;' % (segexpr(o), ea(o))
        if o.kind == 'reg': return 'm.jmpaddr(r, P, r.%s); return;' % o.r
        raise KeyError('indirect jmp ' + tgt)
    if mn == 'call':
        tgt = ops[0].strip()
        if tgt == 'stuntsmain': tgt = 'ported_stuntsmain_'
        mm = re.match(r'^(?:near ptr\s+|far ptr\s+)?(\w+)$', tgt)
        if mm and mm.group(1) in PROCS:
            callee = PROCS[mm.group(1)]
            far = tgt.startswith('far ptr') or (callee['kind'] == 'far' and not tgt.startswith('near ptr'))
            return 'm.call(r, P, %s, %d);' % (json.dumps(mm.group(1)), 4 if far else 2)
        if mm and mm.group(1) in GLABELS:
            pr, idx = GLABELS[mm.group(1)]
            return 'm.call(r, P, %s, %d, %d);' % (json.dumps(pr), 4 if tgt.startswith('far ptr') else 2, idx)
        o = parse_operand(tgt, ctx)
        if o.kind == 'mem':
            if (o.size or 2) == 4 or tgt.startswith('dword'): return 't = %s; m.callfar(r, P, m.rw(%s, (t + 2) & 0xFFFF), m.rw(%s, t));' % (ea(o), segexpr(o), segexpr(o))
            return 'm.callptr(r, P, m.rw(%s, %s), 2);' % (segexpr(o), ea(o))
        if o.kind == 'reg': return 'm.callptr(r, P, r.%s, 2);' % o.r
        raise KeyError('call ' + tgt)
    if mn == 'iret':
        return 'm.iret(r); return;'
    if mn in ('ret', 'retn', 'retf'):
        n = imm_expr(ops[0], ctx) if ops and ops[0] else 0
        w = 4 if (mn == 'retf' or (mn == 'ret' and ctx.proc['kind'] == 'far')) else 2
        return 'm.ret(r, %d, %d); return;' % (w, n)
    if mn == 'leave':
        return 'r.sp = r.bp; r.bp = m.pop(r);'
    if mn == 'enter':
        return 'm.push(r, r.bp); r.bp = r.sp; r.sp = (r.sp - %d) & 0xFFFF;' % imm_expr(ops[0], ctx)
    raise KeyError('mnemonic ' + mn)

def split_ops(s):
    out, cur, depth, q = [], '', 0, None
    for ch in s:
        if q:
            cur += ch
            if ch == q: q = None
        elif ch in '\'"': q = ch; cur += ch
        elif ch in '[(': depth += 1; cur += ch
        elif ch in '])': depth -= 1; cur += ch
        elif ch == ',' and depth == 0: out.append(cur.strip()); cur = ''
        else: cur += ch
    if cur.strip(): out.append(cur.strip())
    return out

# ---------------------------------------------------------------- main
parse_structs(open(os.path.join(SRC, 'structs.inc'), encoding='latin-1').read())
parse_code_files()
CODESEG_OF = {}
for _i, _fn in enumerate(sorted(os.listdir(SRC))):
    if re.match(r'seg\d+\.asm$', _fn): CODESEG_OF[_fn] = 0x9000 + _i * 0x100
# global label table: label -> (proc, case number), numbered the same way translate_proc does
GLABELS = {}
GADDR = {}
for _name, _p in PROCS.items():
    _case = 1
    for raw in _p['lines']:
        l = strip_comment(raw)
        ml = re.match(r'^(\w+)\s+label\s+(near|far|byte|word|dword)\s*$', l.strip(), re.I)
        mm = re.match(r'^(\w+):', l.strip())
        name_ = ml.group(1) if ml else (mm.group(1) if mm and not re.match(r'^(es|ds|ss|cs)$', mm.group(1), re.I) else None)
        if name_:
            GLABELS[name_] = (_name, _case); GADDR[name_] = 0xC000 + len(GADDR); _case += 1
parse_types('dseg.inc')
parse_consts()
parse_data('dseg.asm')
parse_code_data()
# pack code-segment data contiguously from C000 (clear of VGA memory at A000)
_remap, _next = {}, 0xC000
for _k in sorted(CSBYTES):
    _remap[_k] = _next; _next += (len(CSBYTES[_k]) + 15) // 16 + 1
assert _next < 0xF000, 'code data too large'
CSBYTES = {_remap[k]: v for k, v in CSBYTES.items()}
for _k, (_sg, _o, _w) in list(CSDATA.items()): CSDATA[_k] = (_remap[_sg], _o, _w)
for _k in CODESEG_OF: CODESEG_OF[_k] = _remap.get(CODESEG_OF[_k], CODESEG_OF[_k])
resolve_data()
for _sg, _o, _w, _n, _isoff, _fn in CSREFS:
    if _n not in CSDATA: print('code data: unresolved', _n, 'in', _fn); continue
    _v = CSDATA[_n][1] | (0 if _isoff or _w != 4 else CSDATA[_n][0] << 16)
    CSBYTES[_remap[_sg]][_o:_o + _w] = (_v & ((1 << 8 * _w) - 1)).to_bytes(_w, 'little')
CSTYPE = {}
for _fn in os.listdir(SRC):
    if _fn.endswith('.inc'):
        for l in open(os.path.join(SRC, _fn), encoding='latin-1'):
            m = re.match(r'^\s*extrn\s+(\w+)\s*:\s*(\w+)', l)
            if m and m.group(2) in STRUCTS and m.group(1) in CSDATA: CSTYPE[m.group(1)] = m.group(2)
want = set(sys.argv[3].split(',')) if len(sys.argv) > 3 else None
procs_js, errors = [], 0
for name in sorted(PROCS):
    if want and name not in want: continue
    js = translate_proc(PROCS[name])
    errors += js.count('untranslated in')
    procs_js.append(js)
with open(OUT, 'w') as f:
    f.write('// Generated by tools/asm2js.py from Restunts asmorig. Do not edit.\n')
    f.write("'use strict';\n(function (root) {\nconst P = {};\n")
    f.write('const DSEG = %d, CODESEG = %d;\n' % (DSEG, CODESEG))
    f.write('const DSEG_IMAGE = %s;\n' % json.dumps(base64.b64encode(bytes(DATA)).decode()))
    f.write('const SYM = %s;\n' % json.dumps(DSYM))
    f.write('const CSDATA = %s;\n' % json.dumps({str(k): base64.b64encode(bytes(v)).decode() for k, v in CSBYTES.items()}))
    f.write('const CSYM = %s;\n' % json.dumps({k: [v[0], v[1]] for k, v in CSDATA.items()}))
    f.write('const LABELS = %s;\n' % json.dumps({k: [v[0], v[1], GADDR[k]] for k, v in GLABELS.items()}))
    f.write('const GLAB = %s;\n' % json.dumps({v: GLABELS[k] for k, v in GADDR.items()}))
    f.write('const CODE = %s;\n' % json.dumps({v: k for k, v in CODE_SYMS.items()}))
    f.write('const STRUCTS = %s;\n' % json.dumps({k: {'size': v['size'], 'fields': {fk: fv[0] for fk, fv in v['fields'].items()}} for k, v in STRUCTS.items()}))
    f.write('\n'.join(procs_js))
    f.write('\nroot.StuntsCode = { P, DSEG, CODESEG, DSEG_IMAGE, SYM, CODE, GLAB, LABELS, STRUCTS, CSDATA, CSYM };\n})(typeof window !== "undefined" ? window : globalThis);\n')
print('procs', len(procs_js), 'untranslated instructions', errors, 'data bytes', len(DATA), 'symbols', len(DSYM))
