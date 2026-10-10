# Geometry gap check over whole tracks: looks at each track's pieces from many low places around them with the page's
# ?gapviz mode (the sky magenta, the horizon's pictures left out) and finds sky seen through something (cut off from
# the open sky above):
#   crack  a thin line of it (hill tiles, a wall and its roof that should meet)
#   hole   a patch of it (under a roof whose underside is not drawn, through a house; also, rightly, under a bridge)
# (one-sided faces seen from behind are not drawn, so what shows through them is the sky too)
# Writes outdir/report.txt, for each view with something its picture with the places boxed (outdir/hit-*.png), and
# every finding up close (outdir/crops-*.png, numbered in the report's order).
#
#   python3 stunts/tools/gaps.py outdir [TRACK ...] [--views 48] [--min 6] [--again]   (--again: the pictures already there)
#   python3 stunts/tools/gaps.py outdir TRACK --props   each building (scenery shape) on the track up close from 8 sides,
#                                                        low, half way up and close below its eaves: outdir/TRACK/prop-<shape>.png sheets
# (the server, stunts/tools/serve.py 8766, must be running; tracks from the game's own: DEFAULT, ALPS, ...)
import base64, json, os, subprocess, sys
import numpy as np
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
args = [a for a in sys.argv[1:]]
def opt(k, d):
    if k in args: i = args.index(k); v = args[i + 1]; del args[i:i + 2]; return v
    return d
AGAIN = '--again' in args
if AGAIN: args.remove('--again')
PROPS = '--props' in args
if PROPS: args.remove('--props')
NV = int(opt('--views', '48')); MIN = int(opt('--min', '6'))
out = args[0]; tracks = args[1:] or ['DEFAULT']
os.makedirs(out, exist_ok=True)

# where to look from: per piece on the track (each static instance), a few places round it a little above the ground
# under them (found by a ray down), keeping only those that see the piece (the first thing a ray towards it meets)
# --props: per scenery shape (no track pieces: those reach the tile's edges), its first instance from 8 sides
PROPCAMS = r'''(() => {
  const T = THREE, base = view.S.game3dshapes, out = [], M = new T.Matrix4(), seen = new Set();
  for (const m of view.statics.children) {
    if (!m.isInstancedMesh || !m.count) continue;
    const i = (m.userData.hi - base) / 22, bb = m.geometry.boundingBox || (m.geometry.computeBoundingBox(), m.geometry.boundingBox);
    if (seen.has(i) || bb.max.y - bb.min.y < 60 || Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z) > 1000 || Math.min(bb.max.x - bb.min.x, bb.max.z - bb.min.z) > 900) continue;
    seen.add(i); m.getMatrixAt(0, M); const p = new T.Vector3().setFromMatrixPosition(M), h = bb.max.y - bb.min.y, r = Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z, h);
    for (let k = 0; k < 24; k++) {
      // (8 low, 8 half way up, 8 close by and low looking up at the eaves)
      const a = (k % 8) * Math.PI / 4 + 0.3, R = k < 16 ? r * 1.1 : r * 0.75, y = k < 8 || k >= 16 ? p.y + 8 : p.y + h * 0.5;
      const c = { x: p.x + Math.cos(a) * R, y, z: -(p.z + Math.sin(a) * R) }, aim = [p.x, p.y + h * (k < 8 ? 0.6 : k < 16 ? 0.5 : 0.85), p.z];
      const vx = aim[0] - c.x, vy = aim[1] - c.y, vz = -aim[2] - c.z;
      out.push({ x: c.x, y: c.y, z: c.z, yaw: Math.atan2(vx, vz) * 180 / Math.PI, pitch: -Math.atan2(vy, Math.hypot(vx, vz)) * 180 / Math.PI, shape: i });
    }
  }
  window.__cams = out; return out.length;
})()'''

CAMS = r'''(() => {
  const T = THREE, ms = view.statics.children.filter(m => m.isInstancedMesh), rc = new T.Raycaster(), M = new T.Matrix4(), out = [];
  const all = []; for (const m of ms) for (let i = 0; i < m.count; i++) { m.getMatrixAt(i, M); const p = new T.Vector3().setFromMatrixPosition(M); all.push(p); }
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const seen = new Set(), pick = all.filter(p => { const k = Math.round(p.x / 256) + ':' + Math.round(p.z / 256); if (seen.has(k)) return false; seen.add(k); return true; });
  for (let n = 0; out.length < NV && n < NV * 20; n++) {
    const t = pick[Math.floor(rnd() * pick.length)], a = rnd() * Math.PI * 2, R = 250 + rnd() * 600;
    const c = new T.Vector3(t.x + Math.cos(a) * R, 6000, t.z + Math.sin(a) * R);
    rc.set(c, new T.Vector3(0, -1, 0)); rc.far = 12000;
    const g = rc.intersectObjects(ms, false)[0], gy = g ? g.point.y : 0;
    c.y = gy + 12 + rnd() * 110;
    const aim = new T.Vector3(t.x, t.y + 40 + rnd() * 120, t.z), d = aim.clone().sub(c), L = d.length(); d.normalize();
    rc.set(c, d); rc.far = L + 400; const h = rc.intersectObjects(ms, false)[0];
    if (h && h.distance < L * 0.6) continue;   // (something in the way close by: inside a hill or a building)
    const yaw = Math.atan2(-d.x, -d.z) * 180 / Math.PI, pitch = Math.asin(d.y) * 180 / Math.PI;
    out.push({ x: c.x, y: c.y, z: -c.z, yaw: -yaw, pitch });
  }
  window.__cams = out; return out.length;
})()'''.replace('NV', str(NV))

def prefs(track):
    b = bytearray(base64.b64decode('UEMwNAABAP8AAAAAAEFMUFMAAAAAAA=='))
    name = track.encode()[:8].ljust(9, b'\0')
    b[13:22] = name
    return base64.b64encode(bytes(b)).decode()

def mask(img):
    a = np.asarray(img.convert('RGB')).astype(int); r, g, b = a[..., 0], a[..., 1], a[..., 2]
    return ((r + b) // 2 - g > 70) & (abs(r - b) < 70)

def erode(m, k):
    o = m.copy()
    for _ in range(k):
        o = o & np.roll(o, 1, 0) & np.roll(o, -1, 0) & np.roll(o, 1, 1) & np.roll(o, -1, 1)
    return o
def dilate(m, k):
    o = m.copy()
    for _ in range(k):
        o = o | np.roll(o, 1, 0) | np.roll(o, -1, 0) | np.roll(o, 1, 1) | np.roll(o, -1, 1)
    return o

def label(m, diag=False):
    # connected regions of a mask: a label per pixel, and per region its box and size
    H, W = m.shape; lab = np.zeros(m.shape, int); res = [None]
    nb = ((1, 0), (-1, 0), (0, 1), (0, -1)) + (((1, 1), (1, -1), (-1, 1), (-1, -1)) if diag else ())
    ys, xs = np.nonzero(m)
    for y0, x0 in zip(ys, xs):
        if lab[y0, x0]: continue
        n = len(res); st = [(y0, x0)]; lab[y0, x0] = n; box = [x0, y0, x0, y0]; cnt = 0
        while st:
            y, x = st.pop(); cnt += 1
            if x < box[0]: box[0] = x
            if y < box[1]: box[1] = y
            if x > box[2]: box[2] = x
            if y > box[3]: box[3] = y
            for dy, dx in nb:
                yy, xx = y + dy, x + dx
                if 0 <= yy < H and 0 <= xx < W and m[yy, xx] and not lab[yy, xx]: lab[yy, xx] = n; st.append((yy, xx))
        res.append((box, cnt))
    return lab, res

report = []
for tr in tracks:
    d = os.path.join(out, tr); os.makedirs(d, exist_ok=True)
    nv = 24 * 24 if PROPS else NV
    steps = [{'eval': "localStorage.setItem('stunts-prefs', '%s'), 1" % prefs(tr)}, {'goto': True}, {'race': True},
             {'css': '#screen, #hud, #bg, #sides { visibility: hidden !important }'},
             {'eval': PROPCAMS if PROPS else CAMS}, {'wait': 5000}]
    for k in range(nv):
        show = "view.statics.children.forEach(m => { if (m.isInstancedMesh) m.visible = (m.userData.hi - view.S.game3dshapes) / 22 === c.shape; }), " if PROPS else ''   # (the building alone)
        steps += [{'eval': "(c => c ? (%sview.debugCam = c, 1) : 0)(window.__cams[%d])" % (show, k)}, {'wait': 250}, {'shot': 'v%02d' % k}]
    steps += [{'eval': 'JSON.stringify(window.__cams)', 'save': 'cams.jsonl'}]
    sf = os.path.join(d, 'script.json'); json.dump(steps, open(sf, 'w'))
    if not AGAIN: subprocess.run(['node', os.path.join(HERE, 'qa.mjs'), sf, d, '--url', 'http://localhost:8766/stunts/?nosound&gapviz'], check=True, stdout=subprocess.DEVNULL)
    cams = json.loads(json.loads(open(os.path.join(d, 'cams.jsonl')).read().splitlines()[-1]))
    if PROPS:
        # one sheet per shape: its 16 views, 4 across
        by = {}
        for k, c in enumerate(cams): by.setdefault(c['shape'], []).append(k)
        for i, ks in by.items():
            sheet = Image.new('RGB', (4 * 400, 6 * 188))
            for n, k in enumerate(ks[:24]):
                f = os.path.join(d, 'v%02d.png' % k)
                if os.path.exists(f): sheet.paste(Image.open(f).convert('RGB').resize((400, 188)), ((n % 4) * 400, (n // 4) * 188))
            sheet.save(os.path.join(d, 'prop-%d.png' % i))
    for k in range(len(cams)):
        f = os.path.join(d, 'v%02d.png' % k)
        if not os.path.exists(f): continue
        img = Image.open(f); sky = mask(img)
        # the open sky: what of it reaches the top of the picture (diagonally too); the rest is seen through something
        lab, _ = label(sky, True)
        seen = sky & ~np.isin(lab, np.unique(lab[0][lab[0] > 0]))
        thin = seen & ~dilate(erode(seen, 2), 2)
        lab, regs = label(seen)
        found = []
        for i, r in enumerate(regs):
            if not r or r[1] < MIN: continue
            (x0, y0, x1, y1), n = r
            found.append(('crack' if thin[lab == i].sum() > n * 0.6 else 'hole', (x0, y0, x1, y1), n))
        if not found: continue
        im = img.convert('RGB'); dr = ImageDraw.Draw(im)
        for kind, (x0, y0, x1, y1), n in found:
            dr.rectangle([x0 - 6, y0 - 6, x1 + 6, y1 + 6], outline=(255, 255, 0) if kind == 'crack' else (0, 220, 255), width=2)
            report.append('%s v%02d %s %dpx at (%d,%d)-(%d,%d) cam %s' % (tr, k, kind, n, x0, y0, x1, y1, json.dumps({q: round(v, 1) for q, v in cams[k].items()})))
        im.save(os.path.join(out, 'hit-%s-v%02d.png' % (tr, k)))

# every finding up close on one sheet (3x, numbered as in the report)
crops = []
for line in report:
    tr, v, kind, _, _, box = line.split()[:6]
    x0, y0, x1, y1 = [int(q) for q in box.replace('(', '').replace(')', '').replace('-', ',').split(',')]
    cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
    im = Image.open(os.path.join(out, tr, v + '.png')).convert('RGB').crop((cx - 80, cy - 40, cx + 80, cy + 40)).resize((480, 240), Image.NEAREST)
    ImageDraw.Draw(im).text((4, 4), '%d %s %s %s' % (len(crops), tr, v, kind), fill=(255, 255, 255))
    crops.append(im)
for s0 in range(0, len(crops), 24):
    sheet = Image.new('RGB', (480 * 4, 240 * 6))
    for i, im in enumerate(crops[s0:s0 + 24]): sheet.paste(im, ((i % 4) * 480, (i // 4) * 240))
    sheet.save(os.path.join(out, 'crops-%d.png' % (s0 // 24)))

open(os.path.join(out, 'report.txt'), 'w').write('\n'.join(report) + '\n')
print('\n'.join(report) or 'no gaps found')
print('%d finding(s)' % len(report))
