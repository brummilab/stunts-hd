#!/usr/bin/env python3
"""Measure Restunts' dseg.asm: byte offset of every label plus the raw bytes, so tables whose
pointers are stored as plain numbers (like trkObjectList) can be resolved to label names.
Writes a JSON blob with only the tables the remake needs (never the whole segment)."""
import json, re, sys

SRC = sys.argv[1]
OUT = sys.argv[2]

lines = open(SRC, encoding='latin-1').read().split('\n')
start = next(i for i, l in enumerate(lines) if l.startswith('dseg segment'))
end = next(i for i, l in enumerate(lines) if l.startswith('dseg ends'))

data = bytearray()
labels = {}
size = {'db': 1, 'dw': 2, 'dd': 4, 'dq': 8, 'dt': 10}
num = re.compile(r'^[-+]?(?:[0-9][0-9a-fA-F]*h|\d+)$')

def val(tok):
    tok = tok.strip()
    if num.match(tok):
        return int(tok[:-1], 16) if tok.lower().endswith('h') else int(tok)
    return None

def split_items(s):
    out, cur, q, depth = [], '', None, 0
    for ch in s:
        if q:
            cur += ch
            if ch == q: q = None
        elif ch in '\'"':
            q = ch; cur += ch
        elif ch == '(':
            depth += 1; cur += ch
        elif ch == ')':
            depth -= 1; cur += ch
        elif ch == ',' and depth == 0:
            out.append(cur); cur = ''
        else:
            cur += ch
    if cur.strip(): out.append(cur)
    return out

def emit(item, w):
    item = item.strip()
    m = re.match(r'^(\S+)\s+dup\s*\((.*)\)$', item, re.I)
    if m:
        n = val(m.group(1))
        for _ in range(n):
            for sub in split_items(m.group(2)): emit(sub, w)
        return
    if item[:1] in '\'"' and w == 1:
        data.extend(item[1:-1].encode('latin-1')); return
    v = val(item)
    if v is None: v = 0  # ?, offset x, seg x: value unknown at assembly time here
    data.extend((v & ((1 << (8 * w)) - 1)).to_bytes(w, 'little'))

for l in lines[start + 1:end]:
    code = l.split(';', 1)[0].rstrip()
    if not code.strip(): continue
    m = re.match(r'^(\w+)?\s*(db|dw|dd|dq|dt)\s+(.*)$', code, re.I)
    if m:
        if m.group(1): labels[m.group(1)] = len(data)
        for it in split_items(m.group(3)): emit(it, size[m.group(2).lower()])
        continue
    m = re.match(r'^(\w+)\s+(label|=)', code)
    if m: labels[m.group(1)] = len(data)

# Calibrate: labels named after their linear address give the segment base
bases = {}
for name, off in labels.items():
    m = re.match(r'^(?:byte|word|dword|off|unk|stru|asc|a\w*?)_([0-9A-F]{5})$', name)
    if m: bases.setdefault(int(m.group(1), 16) - off, 0); bases[int(m.group(1), 16) - off] += 1
base = max(bases, key=bases.get)
print('segment bytes', len(data), 'labels', len(labels), 'linear base', hex(base), 'votes', bases[base], 'of', sum(bases.values()))

def table(name, length):
    o = labels[name]; return list(data[o:o + length])

out = {
    'labels': {k: labels[k] for k in ('trkObjectList', 'game3dshapes', 'material_color_list', 'material_pattern_list') if k in labels},
    'trkObjectList': table('trkObjectList', 14 * 256),
    'material_color_list': table('material_color_list', labels['material_pattern_list'] - labels['material_color_list']),
}
# TRKOBJINFO records pointed to by trkObjectList, keyed by segment offset
infos = {}
tl = out['trkObjectList']
for i in range(0, len(tl), 14):
    p = tl[i] | tl[i + 1] << 8
    if p and p not in infos and p + 14 <= len(data): infos[p] = list(data[p:p + 14])
out['trkObjInfo'] = infos
for name, n in [('sceneshapes2', 14 * 19), ('sceneshapes3', 14 * 8), ('fence_TrkObjCodes', 8), ('word_3C0D6', 16),
                ('unk_3C0A2', 4), ('unk_3C0A6', 8), ('unk_3C0AE', 8), ('unk_3C0B6', 16), ('byte_3C0C6', 16), ('hillHeightConsts', 4)]:
    if name in labels: out[name] = table(name, n)
o = labels['aBarn']
out['shapeNames'] = [data[o + i * 5:o + i * 5 + 4].decode('latin-1') for i in range(116)]
json.dump(out, open(OUT, 'w'))
print('game3dshapes at', hex(labels['game3dshapes']), 'trkObjectList at', hex(labels['trkObjectList']))
