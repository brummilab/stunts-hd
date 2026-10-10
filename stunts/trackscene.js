// Builds the static scene of a Stunts track: which original shape goes where.
// Placement rules follow Restunts' ported frame.c (tile grid, multi-tile anchors, overlays,
// elevated tiles, border fences) and the hill-road substitution from seg004.asm.
// Coordinates here are Stunts world units (1 tile = 1024, y up, left-handed).
'use strict';
(function (root) {
  const TILE = 1024, HILL = 450;
  const u16 = (a, o) => a[o] | (a[o + 1] << 8);

  function decodeObjects(bytes, shapeAt) {
    const list = [];
    for (let i = 0; i * 14 + 14 <= bytes.length; i++) {
      const o = i * 14;
      list.push({
        info: u16(bytes, o), rot: u16(bytes, o + 2), shape: shapeAt(u16(bytes, o + 4)), lo: shapeAt(u16(bytes, o + 6)),
        overlay: bytes[o + 8], surface: (bytes[o + 9] << 24) >> 24, zbias: bytes[o + 10], multi: bytes[o + 11], phys: bytes[o + 12],
      });
    }
    return list;
  }

  // seg004.asm subst_hillroad_track: straight roads and ramps on a slope become slope pieces
  const HILLROAD = {
    7: { 0x04: 0xB6, 0x0E: 0xBA, 0x18: 0xBE, 0x27: 0xC2, 0x3B: 0xC2, 0x62: 0xC2 },
    8: { 0x05: 0xB7, 0x0F: 0xBB, 0x19: 0xBF, 0x24: 0xC3, 0x38: 0xC3, 0x5F: 0xC3 },
    9: { 0x04: 0xB8, 0x0E: 0xBC, 0x18: 0xC0, 0x26: 0xC4, 0x3A: 0xC4, 0x61: 0xC4 },
    10: { 0x05: 0xB9, 0x0F: 0xBD, 0x19: 0xC1, 0x25: 0xC5, 0x39: 0xC5, 0x60: 0xC5 },
  };

  function buildScene(tables, trk) {
    const g3d = tables.labels.game3dshapes, names = tables.shapeNames;
    const shapeAt = p => {
      if (!p) return null;
      const d = p - g3d;
      if (d % 22 !== 0) return null;
      const i = d / 22;
      if (i < names.length) return names[i];
      return i >= 124 && i <= 129 ? 'car' : null;
    };
    const objs = decodeObjects(tables.trkObjectList, shapeAt);
    const terrObjs = decodeObjects(tables.sceneshapes2, shapeAt);
    const items = trk.items, terr = trk.terrain;
    const elemAt = (c, r) => (c < 0 || r < 0 || c > 29 || r > 29) ? 0 : items[r][c];
    // terrain rows are stored bottom-to-top; the item grid top-to-bottom
    const terrAt = (c, r) => (c < 0 || r < 0 || c > 29 || r > 29) ? 0 : terr[29 - r][c];
    const cx = c => c * TILE + TILE / 2, cz = r => r * TILE + TILE / 2;
    const place = [];
    const add = (shape, x, y, z, rot, paint, kind) => { if (shape) place.push({ shape, x, y, z, rot, paint: paint || 0, kind }); };
    let start = null;

    for (let r = 0; r < 30; r++) for (let c = 0; c < 30; c++) {
      let e = elemAt(c, r), t = terrAt(c, r);
      if (e >= 0xFD) continue; // filler tiles are drawn by their main tile
      if (e && t >= 7 && t <= 10) { e = (HILLROAD[t] || {})[e] || 0; t = 0; }
      // terrain
      let hill = 0;
      if (t === 6) { hill = HILL; if (e) t = 0; }
      if (t) { const T = terrObjs[t]; add(T.shape, cx(c), t === 6 ? HILL : 0, cz(r), T.rot, 0, 'terrain'); }
      if (!e) continue;
      const O = objs[e];
      // multi-tile anchor: the main tile is the bottom-left of the block (fillers sit above and to the right)
      const x = (O.multi & 2) ? (c + 1) * TILE : cx(c);
      const z = (O.multi & 1) ? r * TILE : cz(r);
      if (hill) {
        // flat hill tops under raised multi-tile pieces
        const offs = { 0: [[0, 0]], 1: [[0, 512], [0, -512]], 2: [[512, 0], [-512, 0]], 3: [[-512, 512], [512, 512], [-512, -512], [512, -512]] }[O.multi];
        for (const [ox, oz] of offs) add('high', x + ox, hill, z + oz, 0, 0, 'terrain');
      }
      const paint = O.surface >= 0 ? O.surface : 0;
      if (O.overlay) { const V = objs[O.overlay]; add(V.shape, x, hill, z, V.rot, V.surface >= 0 ? V.surface : 0, 'overlay'); }
      add(O.shape, x, hill, z, O.rot, paint, O.phys >= 0x40 ? 'scenery' : 'track');
      if ([0x01, 0x86, 0x87, 0x88, 0x89, 0x93, 0x94, 0x95, 0x96, 0xB3, 0xB4, 0xB5].includes(e)) start = { x, y: hill, z, rot: O.rot, tile: [c, r] };
    }
    // border fences (frame.c: fence_TrkObjCodes / word_3C0D6)
    // di picks fenc (even) or the corner piece cfen (odd); rotation = word_3C0D6[di]
    const FROT = [0, 0, 256, 256, 512, 512, 768, 768];
    for (let r = 0; r < 30; r++) for (let c = 0; c < 30; c++) {
      let di = -1;
      if (c === 0) di = r === 29 ? 7 : r === 0 ? 5 : 6;
      else if (c === 29) di = (r === 29 || r === 0) ? 1 : 2;
      else if (r === 29) di = 0;
      else if (r === 0) di = 4;
      if (di >= 0) add(di & 1 ? 'cfen' : 'fenc', cx(c), 0, cz(r), FROT[di], 0, 'fence');
    }
    return { place, start, horizon: trk.horizon, objs };
  }

  root.StuntsTrack = { buildScene, TILE, HILL };
})(typeof window !== 'undefined' ? window : globalThis);
