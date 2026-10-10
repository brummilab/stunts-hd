// Alpha game loop: drive the original track in the original car, with Stunts-style cameras,
// lap timing, crashes and replays.
'use strict';
(function (root) {
  const { V, Q } = root;
  const P = root.StuntsPhysics, S = P.SCALE, ANG = 2 * Math.PI / 1024;
  const DT = 1 / 240;

  // The original loop is 12 flat segments; at speed each 30-degree joint acts like a kerb and flips the car.
  // The game gives loops their own physical model, so collision uses a smooth surface fitted to the
  // loop shape's own dimensions (circle r=449 centred at y=524, 31-degree run-in ramps, width 400,
  // centre line drifting from x=-200 to x=+200), in Stunts shape-local units.
  function loopSurface() {
    const R = 449, CY = 524, W = 200, quads = [];
    const ramp = 31 * Math.PI / 180, fil = 250, tl = fil * Math.tan(ramp / 2);
    // profile for the climbing half, as (y, z) points from the ground run-in up to the top
    const prof = [];
    for (let i = 0; i <= 8; i++) { const a = ramp * i / 8; prof.push([fil - fil * Math.cos(a), -tl + fil * Math.sin(a)]); }
    const a0 = Math.atan2(224, 524 - 135);               // where the ramp meets the circle
    for (let i = 0; i <= 64; i++) { const a = a0 + (Math.PI - a0) * i / 64; prof.push([CY - R * Math.cos(a), R * Math.sin(a)]); }
    const half = prof.length;
    // descending half mirrors z; the centre line drifts across the full width over the whole loop
    const path = prof.concat(prof.slice(0, -1).reverse().map(([y, z]) => [y, -z]));
    let len = 0; const cum = [0];
    for (let i = 1; i < path.length; i++) { len += Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]); cum.push(len); }
    for (let i = 1; i < path.length; i++) {
      const x0 = -W + 2 * W * cum[i - 1] / len, x1 = -W + 2 * W * cum[i] / len;
      const [y0, z0] = path[i - 1], [y1, z1] = path[i];
      quads.push([[x0 - W, y0, z0], [x0 + W, y0, z0], [x1 + W, y1, z1], [x1 - W, y1, z1]]);
      quads[quads.length - 1].centre = [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2];
    }
    return quads;
  }
  const LOOP_QUADS = loopSurface();

  // Shape polygons placed in the world, converted to metres in Three.js axes
  function buildCollision(assets, layout) {
    const W = new P.CollisionWorld(6);
    for (const p of layout.place) {
      const sh = assets.shapes[p.shape]; if (!sh) continue;
      if (p.kind === 'fence') continue;
      const a = -p.rot * ANG, c = Math.cos(a), s = Math.sin(a);
      const tv = sh.verts.map(v => {
        const x = v[0], y = v[1], z = -v[2];
        return [(x * c + z * s + p.x) * S, (y + p.y) * S, (-x * s + z * c - p.z) * S];
      });
      const surf = p.kind === 'terrain' || p.kind === 'scenery' ? P.SURF_GRASS : [P.SURF_ROAD, P.SURF_DIRT, P.SURF_ICE][p.paint] ?? P.SURF_ROAD;
      if (p.shape === 'loop') {
        const tf = v => { const x = v[0], y = v[1], z = -v[2]; return [(x * c + z * s + p.x) * S, (y + p.y) * S, (-x * s + z * c - p.z) * S]; };
        const ax = V.norm(V.sub(tf([1, 0, 0]), tf([0, 0, 0])));
        for (const q of LOOP_QUADS) {
          const t = q.map(tf), guide = { point: tf(q.centre), axis: ax };
          W.add(t[0], t[1], t[2], surf, guide); W.add(t[0], t[2], t[3], surf, guide);
        }
        continue;
      }
      for (const pr of sh.prims) {
        if (pr.type < 3 || pr.type > 10) continue;
        const pts = pr.idx.map(i => tv[i]);
        for (let i = 1; i < pts.length - 1; i++) { W.add(pts[0], pts[i], pts[i + 1], surf); W.tris[W.tris.length - 1].src = p.shape; }
      }
    }
    return W;
  }

  class Game {
    constructor(opts) {
      Object.assign(this, opts); // assets, world, renderer, camera, hud
      this.keys = new Set();
      this.view = 'chase';
      this.mode = 'drive';
      this.replay = null;
      addEventListener('keydown', e => this.onKey(e, true));
      addEventListener('keyup', e => this.onKey(e, false));
      addEventListener('blur', () => this.keys.clear());
    }
    onKey(e, down) {
      if (e.target && /INPUT|SELECT/.test(e.target.tagName)) return;
      const k = e.code;
      if (down) this.keys.add(k); else this.keys.delete(k);
      if (/^Arrow|Space/.test(k)) e.preventDefault();
      if (!down) return;
      if (k === 'F1' || k === 'Digit1') { this.view = 'cockpit'; e.preventDefault(); }
      if (k === 'F2' || k === 'Digit2') { this.view = 'chase'; e.preventDefault(); }
      if (k === 'F3' || k === 'Digit3') { this.view = 'tv'; e.preventDefault(); }
      if (k === 'F4' || k === 'Digit4') { this.view = 'orbit'; e.preventDefault(); }
      if (k === 'KeyR' && this.mode === 'drive') this.recover();
      if (k === 'Enter' && this.mode === 'finished') this.startReplay();
      if (k === 'Enter' && this.mode === 'replay') this.restart();
      if (k === 'KeyP' && this.mode === 'replay') this.replay.playing = !this.replay.playing;
      if (k === 'Escape') this.restart();
    }
    async load(trackName, carId) {
      const trk = await this.assets.loadTrack(trackName);
      this.world.horizon = await this.assets.loadHorizon(trk.horizon);
      this.layout = this.world.buildTrack(trk);
      this.collision = buildCollision(this.assets, this.layout);
      this.carData = await this.assets.loadCar(carId);
      try { this.dash = await this.assets.loadDash(carId); } catch (e) { this.dash = null; }
      if (this.model) this.world.scene.remove(this.model);
      this.model = this.world.carModel(this.carData, 0);
      this.wheelMap = null;
      this.world.scene.add(this.model);
      this.car = new P.Car(this.carData.spec, this.collision);
      // track tiles for lap validation
      this.roadTiles = new Set();
      trk.items.forEach((row, r) => row.forEach((e, c) => { if (e && e < 0x97 || (e >= 0xB3 && e <= 0xC5)) this.roadTiles.add(c + ',' + r); }));
      // TV cameras: beside every other track piece, raised above elevated road, offset to alternating sides
      this.tvCams = this.layout.place.filter(p => p.kind === 'track').filter((_, i) => i % 2 === 0)
        .map((p, i) => [p.x * S + (i & 1 ? 16 : -16), p.y * S + 9, -p.z * S + (i & 2 ? 16 : -16)]);
      this.tvCam = null;
      this.restart();
    }
    restart() {
      const st = this.layout.start || { x: 15360, y: 0, z: 15360, rot: 0 };
      this.startPos = [st.x * S, st.y * S + 0.5, -st.z * S];
      this.startYaw = -st.rot * ANG;
      this.car.reset(this.startPos, this.startYaw);
      this.safe = { pos: this.startPos.slice(), yaw: this.startYaw, t: 0 };
      this.time = 0; this.acc = 0; this.mode = 'countdown'; this.count = 3.2;
      this.visited = new Set(); this.leftStart = false; this.crashTimer = 0;
      this.rec = []; this.replay = null; this.penalty = 0;
      this.hud.msg('');
    }
    recover() {
      this.car.reset(this.safe.pos, this.safe.yaw);
      this.penalty += 3;
      this.hud.flash('+3 s recovery');
    }
    input() {
      const k = this.keys, has = (...c) => c.some(x => k.has(x));
      let steer = (has('ArrowRight', 'KeyD') ? 1 : 0) - (has('ArrowLeft', 'KeyA') ? 1 : 0);
      let throttle = has('ArrowUp', 'KeyW') ? 1 : 0, brake = has('ArrowDown', 'KeyS') ? 1 : 0;
      const pad = (navigator.getGamepads ? [...navigator.getGamepads()] : []).find(p => p);
      if (pad) {
        if (Math.abs(pad.axes[0]) > 0.12) steer = pad.axes[0];
        throttle = Math.max(throttle, pad.buttons[7] ? pad.buttons[7].value : 0, pad.buttons[0] && pad.buttons[0].pressed ? 1 : 0);
        brake = Math.max(brake, pad.buttons[6] ? pad.buttons[6].value : 0, pad.buttons[1] && pad.buttons[1].pressed ? 1 : 0);
      }
      // holding brake at a standstill selects reverse, as in Stunts
      const reverse = brake > 0 && Math.abs(this.car.speed) < 1.5 && !throttle ? true : (this.car.gear === -1 && brake > 0);
      if (reverse) { const t = brake; brake = throttle; throttle = t; }
      return { steer, throttle, brake, handbrake: has('Space'), reverse };
    }
    tile() { return [Math.floor(this.car.pos[0] / S / 1024), Math.floor(-this.car.pos[2] / S / 1024)]; }
    update(dt) {
      if (this.mode === 'replay') { this.updateReplay(dt); return; }
      if (this.mode === 'countdown') {
        this.count -= dt;
        this.hud.msg(this.count > 0.2 ? String(Math.ceil(this.count - 0.2)) : 'GO');
        if (this.count <= 0) { this.mode = 'drive'; this.hud.msg(''); }
      }
      const driving = this.mode === 'drive';
      const inp = driving ? this.input() : { steer: 0, throttle: 0, brake: 1, reverse: false };
      this.acc += dt;
      while (this.acc >= DT) {
        this.car.step(DT, inp);
        this.acc -= DT;
      }
      if (driving) this.time += dt;
      // record at 30 Hz for replays
      if (this.mode !== 'countdown' && (this.rec.length === 0 || this.time - this.rec[this.rec.length - 1].t >= 1 / 30)) this.rec.push(this.snapshot());
      if (this.car.crashed) {
        if (!this.crashTimer) { this.crashTimer = 2.2; this.hud.msg('CRASHED'); this.audio && this.audio.crash(); }
        this.crashTimer -= dt;
        if (this.crashTimer <= 0) { this.crashTimer = 0; this.recover(); this.hud.msg(''); }
      } else if (driving) {
        const [c, r] = this.tile(), key = c + ',' + r;
        if (this.roadTiles.has(key)) this.visited.add(key);
        const up = Q.rotate(this.car.q, [0, 1, 0]);
        if (up[1] > 0.95 && this.car.wheels.every(w => w.load > 0) && this.time - this.safe.t > 1) {
          const f = Q.rotate(this.car.q, [0, 0, -1]);
          this.safe = { pos: V.add(this.car.pos, [0, 0.3, 0]), yaw: Math.atan2(-f[0], -f[2]), t: this.time };
        }
        const st = this.layout.start;
        const onStart = st && c === st.tile[0] && r === st.tile[1];
        if (!onStart && this.time > 3) this.leftStart = true;
        if (onStart && this.leftStart) {
          const need = Math.floor(this.roadTiles.size * 0.85);
          if (this.visited.size >= need) this.finish();
          else if (!this.warned) { this.warned = true; this.hud.flash('Missed part of the track: ' + (need - this.visited.size) + ' tiles to go'); setTimeout(() => this.warned = false, 3000); }
        }
      }
    }
    finish() {
      this.mode = 'finished';
      const total = this.time + this.penalty;
      let best = null;
      try { best = parseFloat(localStorage.getItem('restunts-best') || ''); } catch (e) { /* storage unavailable */ }
      const isBest = !best || total < best;
      if (isBest) try { localStorage.setItem('restunts-best', String(total)); } catch (e) { /* storage unavailable */ }
      this.hud.msg('FINISH  ' + fmt(total) + (isBest ? '  NEW BEST' : '') + '\nEnter: watch replay · Esc: race again');
    }
    snapshot() {
      return { t: this.time, pos: this.car.pos.slice(), q: this.car.q.slice(), steer: this.car.steer, spin: this.car.wheels.map(w => w.spin), kmh: this.car.kmh, rpm: this.car.rpm, gear: this.car.gear, crashed: !!this.car.crashed };
    }
    startReplay() {
      this.mode = 'replay'; this.replay = { i: 0, t: 0, playing: true, speed: 1 };
      this.view = 'tv';
      this.hud.msg('');
    }
    updateReplay(dt) {
      const R = this.replay, rec = this.rec;
      if (R.playing) R.t += dt * R.speed;
      if (R.t > rec[rec.length - 1].t) R.t = 0;
      while (R.i < rec.length - 2 && rec[R.i + 1].t < R.t) R.i++;
      while (R.i > 0 && rec[R.i].t > R.t) R.i--;
      const a = rec[R.i], b = rec[Math.min(R.i + 1, rec.length - 1)], k = b.t > a.t ? Math.min(1, (R.t - a.t) / (b.t - a.t)) : 0;
      this.car.pos = V.lerp(a.pos, b.pos, k); this.car.q = Q.slerp(a.q, b.q, k); this.car.steer = a.steer;
      this.car.wheels.forEach((w, i) => w.spin = a.spin[i] + (b.spin[i] - a.spin[i]) * k);
      this.car.speed = a.kmh / 3.6; this.car.rpm = a.rpm; this.car.gear = a.gear;
      this.hud.replay(R.t, rec[rec.length - 1].t);
    }
    // Sync the car model and camera
    present(camera, dt) {
      const car = this.car, m = this.model;
      m.position.set(...car.pos);
      m.quaternion.set(...car.q);
      m.visible = this.view !== 'cockpit';
      if (!this.wheelMap) this.wheelMap = m.wheels.map(w => {
        let bi = 0, bd = Infinity;
        car.wheels.forEach((pw, i) => { const d = Math.hypot(pw.mount[0] - w.position.x * S, pw.mount[2] - w.position.z * S); if (d < bd) { bd = d; bi = i; } });
        return bi;
      });
      for (const [i, w] of m.wheels.entries()) {
        const pw = car.wheels[this.wheelMap[i]];
        w.rotation.y = w.front ? -car.steer : 0;
        if (w.spin) w.spin.rotation.x = -(pw ? pw.spin : 0);
      }
      const f = Q.rotate(car.q, [0, 0, -1]), up = Q.rotate(car.q, [0, 1, 0]);
      const T = root.THREE;
      if (this.view === 'cockpit') {
        const eye = V.add(car.pos, Q.rotate(car.q, [-0.3, 0.92, 0.25]));
        camera.position.set(...eye);
        camera.up.set(...up);
        camera.lookAt(...V.add(eye, f));
      } else if (this.view === 'chase') {
        // close behind and a little above, following the car's heading with only a slight lag
        const flat = Math.hypot(f[0], f[2]) > 0.2 ? V.norm([f[0], 0, f[2]]) : (this.chaseDir || [0, 0, -1]);
        this.chaseDir = this.chaseDir ? V.norm(V.lerp(this.chaseDir, flat, 1 - Math.exp(-dt * 8))) : flat;
        const want = V.add(V.madd(car.pos, this.chaseDir, -7.5), [0, 2.4, 0]);
        if (!this.chase || V.len(V.sub(this.chase, want)) > 30) this.chase = want;
        this.chase = V.lerp(this.chase, want, 1 - Math.exp(-dt * 14));
        camera.position.set(...this.chase); camera.up.set(0, 1, 0);
        camera.lookAt(...V.add(V.madd(car.pos, this.chaseDir, 3), [0, 0.9, 0]));
      } else if (this.view === 'tv') {
        const target = V.add(car.pos, [0, 0.8, 0]);
        const sees = c => {
          if (V.len(V.sub(c, target)) > 140) return false;
          const d = V.sub(target, c), L = V.len(d), h = this.collision.raycast(c, V.scale(d, 1 / L), L - 2.5);
          return !h;
        };
        if (!this.tvCam || !sees(this.tvCam)) {
          const sorted = this.tvCams.slice().sort((a, b) => V.len(V.sub(a, target)) - V.len(V.sub(b, target)));
          this.tvCam = sorted.slice(0, 12).find(sees) || V.add(target, [12, 8, 12]);
        }
        camera.position.set(...this.tvCam); camera.up.set(0, 1, 0); camera.lookAt(...V.add(car.pos, [0, 0.8, 0]));
      } else {
        this.orbitA = (this.orbitA || 0) + dt * 0.25;
        camera.position.set(car.pos[0] + Math.cos(this.orbitA) * 16, car.pos[1] + 6, car.pos[2] + Math.sin(this.orbitA) * 16);
        camera.up.set(0, 1, 0); camera.lookAt(...car.pos);
      }
      // zoom the TV camera so the car stays a readable size
      const fov = this.view === 'tv' ? Math.max(12, Math.min(55, 2 * Math.atan(6 / Math.max(1, V.len(V.sub([camera.position.x, camera.position.y, camera.position.z], car.pos)))) * 180 / Math.PI)) : this.view === 'cockpit' ? 62 : 55;
      if (Math.abs(camera.fov - fov) > 0.01) { camera.fov = fov; camera.updateProjectionMatrix(); }
      this.hud.update(this);
    }
  }
  function fmt(t) { const m = Math.floor(t / 60), s = t - m * 60; return m + ':' + (s < 10 ? '0' : '') + s.toFixed(2); }
  root.StuntsGame = { Game, fmt, buildCollision };
})(window);
