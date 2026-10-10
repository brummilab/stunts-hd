# Builds stunts/map.json: everything the browser needs, beside the player's own GAME.EXE, to translate the game the
# way tools/asm2js.py does from the Restunts disassembly. It holds names and positions only: each proc's lines with
# every instruction replaced by its address in GAME.EXE (decoded in the browser), labels, stack-frame names, jump
# tables by name, the data segment's and code-segment data's places in GAME.EXE, and the few values computed from
# names (pointers to code, to data). No bytes of the game's code or data.
#   python3 tools/mkmap.py <asmorig dir> <exedump.json> <out map.json> [GAME.EXE, for the checksum]
import json, os, re, sys, io, contextlib, runpy
HERE = os.path.dirname(os.path.abspath(__file__))
ASM, DUMP, OUT = sys.argv[1:4]; EXE = sys.argv[4] if len(sys.argv) > 4 else None
sys.argv = ['mapcheck.py', ASM, DUMP, '--show', '0']
with contextlib.redirect_stdout(io.StringIO()): M = runpy.run_path(os.path.join(HERE, 'mapcheck.py'))
G = M['G']; LINEADDR = M['LINEADDR']; PLINES = M['PLINES']; INS = M['INS']; IMG = M['IMG']; rebuild = M['rebuild']
ADDR2LABEL = M['ADDR2LABEL']; SEGPARA = M['SEGPARA']; file_of = M['file_of']
strip_js = M['strip_js']; D_RELOCS = M['RELOC']
SKIP_PROCS = set()   # (none: dos.js runs the C runtime's initialisers in start)

def translate(p, lines):
    q = dict(p); q['lines'] = lines
    return strip_js(G['translate_proc'](q))

def candidates(addr, text):
    """the same instruction with a number in it named: a code label, code-segment data, a data symbol"""
    out = []
    fn = file_of(addr); para = SEGPARA.get(fn)
    nums = re.findall(r'(?<![\w$])(0?[0-9A-F]+h|\d+)(?![\w])', text)
    for n in nums:
        v = G['num'](n)
        if v is None: continue
        names = set()
        for pp in ([para] if para is not None else []) + sorted(set(SEGPARA.values())):
            t = pp * 16 + v
            if t in ADDR2LABEL: names.add(ADDR2LABEL[t])
        for k, (sg, off, w) in G['CSDATA'].items():
            if off == v: names.add(k)
        for name in sorted(names):
            for form in ('offset ' + name, name):
                out.append(re.sub(r'(?<![\w$])%s(?![\w])' % re.escape(n), form, text, count=1))
                if '[' in text: out.append(text.replace('[' + n + ']', name).replace('cs:[', 'cs:' + name + '[').replace('+' + n + ']', ']'))
    return out

procs = []; overrides = 0; textual = []
import time; T0 = time.time()
for name, p in G['PROCS'].items():
    if name in SKIP_PROCS:
        # never run: only its labels, which count in the translator's label numbering
        items = [['t', m.group(1) + ':'] for m in (re.match(r'^(\w+)(?::|\s+label\b)', G['strip_comment'](x).strip()) for x in p['lines']) if m and not re.match(r'^(es|ds|ss|cs)$', m.group(1), re.I)]
        procs.append({'name': name, 'kind': p['kind'], 'file': p['file'], 'next': p.get('next'), 'items': items}); continue
    items = []; rebuilt = []
    for i, raw in zip(PLINES[name], p['lines']):
        a = LINEADDR.get((p['file'], i)); l = G['strip_comment'](raw)
        isdata = re.match(r'^\s*(?:(\w+)\s+)?(db|dw|dd|dt|dq)\s+(.*)$', l)
        if isdata:
            # a jump table entry or a pointer by name stays (names only); bytes are left to GAME.EXE
            if re.match(r'^\s*(?:\w+\s+)?dw\s+offset\s+\w+\s*$', l): items.append(['t', l]); rebuilt.append(l)
            else: items.append(['t', '    db 0']); rebuilt.append('    db 0')
            continue
        if a is None:
            if l.strip(): items.append(['t', l]); rebuilt.append(l)
            continue
        m = re.match(r'^(\s*\w+:\s*)(.*)$', l)
        pre = m.group(1).strip() if m and m.group(2).strip() else ''
        if pre: items.append(['t', pre]); rebuilt.append(pre)
        items.append(['i', a]); rebuilt.append('    ' + rebuild(a))
    A = translate(p, [G['strip_comment'](x) for x in p['lines']]); B = translate(p, rebuilt)
    if A != B:
        score = lambda out: sum(x != y for x, y in zip(out, A)) + abs(len(out) - len(A))
        def wrong():
            # the instructions whose translation differs (each output line ends with its instruction as a comment)
            q = dict(p); q['lines'] = rebuilt; raw = G['translate_proc'](q).split('\n'); out = strip_js('\n'.join(raw))
            bad = {raw[i].split(' // ', 1)[1].strip() for i in range(min(len(out), len(A))) if out[i] != A[i] and ' // ' in raw[i]}
            return [k for k, it in enumerate(items) if it[0] == 'i' and rebuilt[k].strip().replace('*/', '') in bad], score(out)
        ks, cur = wrong()
        # name what the executable has as a number, one instruction at a time
        for k in ks:
            it = items[k]; trial = list(rebuilt)
            for c in candidates(it[1], rebuilt[k]):
                trial[k] = '    ' + c.strip(); sc = score(translate(p, trial))
                if sc < cur: rebuilt[k] = trial[k]; it.append(c.strip()); overrides += 1; cur = sc; break
        if cur:
            # what is left: changes of our own (tools/asm2js.py FIXUPS: the chase camera by default, ...) as text
            src_of = {}
            for j, x in enumerate(p['lines']):
                a_ = LINEADDR.get((p['file'], PLINES[name][j]))
                if a_ is not None and a_ not in src_of: src_of[a_] = re.sub(r'^\w+:\s*', '', G['strip_comment'](x).strip())
            ks, cur = wrong()
            for k in ks:
                it = items[k]
                if len(it) > 2 or it[1] not in src_of: continue
                src = src_of[it[1]]
                trial = list(rebuilt); trial[k] = '    ' + src; sc = score(translate(p, trial))
                if sc < cur: rebuilt[k] = trial[k]; it.append(src); textual.append((name, it[1], src)); cur = sc
        if cur: print('STILL DIFFERENT', name, cur)
        print('  %-30s %5.1fs' % (name, time.time() - T0), file=sys.stderr, flush=True)
    procs.append({'name': name, 'kind': p['kind'], 'file': p['file'], 'next': p.get('next'), 'items': items})

# ---- the data segment: GAME.EXE's bytes (zeros past its end), then the pointers the translator puts there by name
D0 = 0x2B770; DATA = G['DATA']
ex = bytearray(IMG[D0:D0 + len(DATA)]); ex += bytes(len(DATA) - len(ex))
dfix = []; i = 0
while i < len(DATA):
    if DATA[i] != ex[i]:
        j = i
        while j < len(DATA) and DATA[j] != ex[j]: j += 1
        dfix.append([i, list(DATA[i:j])]); i = j
    else: i += 1
# ---- code-segment data: each block's bytes are found in GAME.EXE (a run that continues the last copy, else a search),
# then the pointer values the translator puts there by name
IMGB = bytes(IMG[:D0])
csd = {}
for seg, buf in G['CSBYTES'].items():
    buf = bytes(buf); copy = []; got = bytearray(len(buf)); i = 0; last = None
    while i < len(buf):
        if buf[i] == 0: i += 1; continue
        src = None
        if last is not None and last[0] + (i - last[1]) < len(IMGB) and IMGB[last[0] + (i - last[1])] == buf[i]: src = last[0] + (i - last[1])
        else:
            n = min(12, len(buf) - i)
            if n >= 4: src = IMGB.find(buf[i:i + n]); src = None if src < 0 else src
        if src is None: i += 1; continue
        j = i
        while j < len(buf) and src + j - i < len(IMGB) and IMGB[src + j - i] == buf[j]: j += 1
        if copy and copy[-1][0] + copy[-1][2] == i and copy[-1][1] + copy[-1][2] == src: copy[-1][2] += j - i
        else: copy.append([i, src, j - i])
        got[i:j] = IMGB[src:src + j - i]; last = (src, i); i = j
    fix = []; fill = []; i = 0
    while i < len(buf):
        if buf[i] != got[i]:
            j = i
            while j < len(buf) and buf[j] != got[j]: j += 1
            # (alignment padding, nop bytes, as runs)
            k = i
            while k < j:
                e = k
                while e < j and buf[e] == buf[k]: e += 1
                if e - k >= 3: fill.append([k, e - k, buf[k]])
                elif fix and fix[-1][0] + len(fix[-1][1]) == k: fix[-1][1].extend(buf[k:e])
                else: fix.append([k, list(buf[k:e])])
                k = e
            i = j
        else: i += 1
    csd[seg] = {'size': len(buf), 'copy': copy, 'fill': fill, 'fix': fix}

segname = {}
for _a in sorted(set(D_RELOCS)):
    if _a + 2 > len(IMG): continue
    _v = int.from_bytes(bytes(IMG[_a:_a + 2]), 'little'); _n = M['seg_of_para'](_v)
    if _n: segname[str(_v)] = _n
out = {
    'procs': procs, 'skip': sorted(SKIP_PROCS),
    'dseg': {'at': D0, 'size': len(DATA), 'fix': dfix}, 'csdata': {str(k): v for k, v in csd.items()},
    'dsym': G['DSYM'], 'dsize': G['DSIZE'], 'dtype': G['DTYPE'], 'csym': {k: list(v) for k, v in G['CSDATA'].items()},
    'cstype': G['CSTYPE'],
    # for naming what GAME.EXE has as numbers: labels by address, each code file's start and paragraph, the names of
    # the segment values the loader relocates
    'a2l': {str(k): v for k, v in sorted(ADDR2LABEL.items())},
    'segs': sorted([s0, SEGPARA.get(fn, s0 >> 4), fn] for fn, s0 in M['SEGSTART'].items()),
    'segname': segname, 'consts': G['CONSTS'], 'structs': G['STRUCTS'], 'codeseg_of': G['CODESEG_OF'], 'probes': sorted(G['PROBES']),
}
json.dump(out, open(OUT, 'w'), separators=(',', ':'))
nfix = sum(len(v) for _, v in dfix); cfix = sum(sum(len(v) for _, v in d['fix']) for d in csd.values())
print('procs', len(procs), 'named numbers', overrides, 'text lines (our own changes)', len(textual), 'data fixes', len(dfix), nfix, 'bytes; code data fixes', cfix, 'bytes;', os.path.getsize(OUT) // 1024, 'KB')
for t in textual: print('  text:', t)

# ---- the checksum of the translation (translate.js, as the browser runs it), from the game program given (GAME.EXE):
# the page checks a player's copy against it
if EXE:
    import subprocess
    js = ("const fs=require('fs');globalThis.X86Dec=require(%r);const X=require(%r),tr=require(%r);"
          "const r=tr(X.fromFiles({'GAME.EXE':new Uint8Array(fs.readFileSync(%r))}),JSON.parse(fs.readFileSync(%r,'utf8')));"
          "process.stdout.write(require('crypto').createHash('sha256').update(r.source).digest('hex'))") % (
        os.path.join(HERE, '..', 'x86dec.js'), os.path.join(HERE, '..', 'exefile.js'), os.path.join(HERE, "..", "translate.js"), EXE, OUT)
    out['sum'] = subprocess.run(['node', '-e', js], check=True, capture_output=True, text=True).stdout
    json.dump(out, open(OUT, 'w'), separators=(',', ':'))
    print('checksum', out['sum'])
