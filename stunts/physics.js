// Car physics for the alpha: a raycast-suspension rigid body driving on the original track polygons.
// Engine, gearbox, grip and drag come from the car's original simd record (CAR*.RES).
// Units: metres, seconds; Three.js axes (y up, car faces -z). 1 Stunts shape unit = SCALE metres.
'use strict';
(function (root) {
  const { V, Q } = root;
  const SCALE = 0.04;
  const G = 9.81;
  // simd surfaceGrip index per surface: 1 paved, 2 dirt, 3 ice, 4 grass
  const SURF_ROAD = 0, SURF_DIRT = 1, SURF_ICE = 2, SURF_GRASS = 3;

  // Collision world: triangles in a uniform XZ grid, two-sided raycasts, plus the ground plane.
  class CollisionWorld {
    constructor(cell = 6) { this.cell = cell; this.tris = []; this.grid = new Map(); this.groundSurf = SURF_GRASS; }
    add(a, b, c, surf, guide) {
      const e1 = V.sub(b, a), e2 = V.sub(c, a), n = V.cross(e1, e2), l = V.len(n);
      if (l < 1e-6) return;
      const i = this.tris.length;
      this.tris.push({ a, e1, e2, n: V.scale(n, 1 / l), surf, guide });
      const xs = [a[0], b[0], c[0]], zs = [a[2], b[2], c[2]], s = this.cell;
      const x0 = Math.floor(Math.min(...xs) / s), x1 = Math.floor(Math.max(...xs) / s);
      const z0 = Math.floor(Math.min(...zs) / s), z1 = Math.floor(Math.max(...zs) / s);
      for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
        const k = x * 73856093 ^ z * 19349663; let L = this.grid.get(k); if (!L) this.grid.set(k, L = []); L.push(i);
      }
    }
    raycast(o, d, maxT) {
      let best = null;
      if (d[1] < -1e-6 && o[1] >= 0) { const t = -o[1] / d[1]; if (t <= maxT) best = { t, n: [0, 1, 0], surf: this.groundSurf }; }
      if (d[1] > 1e-6 && o[1] < 0) { const t = -o[1] / d[1]; if (t <= maxT) best = { t, n: [0, -1, 0], surf: this.groundSurf }; }
      const e = V.madd(o, d, maxT), s = this.cell;
      const x0 = Math.floor(Math.min(o[0], e[0]) / s), x1 = Math.floor(Math.max(o[0], e[0]) / s);
      const z0 = Math.floor(Math.min(o[2], e[2]) / s), z1 = Math.floor(Math.max(o[2], e[2]) / s);
      const seen = this._seen || (this._seen = new Set()); seen.clear();
      for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
        const L = this.grid.get(x * 73856093 ^ z * 19349663); if (!L) continue;
        for (const i of L) {
          if (seen.has(i)) continue; seen.add(i);
          const tr = this.tris[i];
          const p = V.cross(d, tr.e2), det = V.dot(tr.e1, p);
          if (Math.abs(det) < 1e-9) continue;
          const inv = 1 / det, sv = V.sub(o, tr.a), u = V.dot(sv, p) * inv;
          if (u < 0 || u > 1) continue;
          const q = V.cross(sv, tr.e1), v = V.dot(d, q) * inv;
          if (v < 0 || u + v > 1) continue;
          const t = V.dot(tr.e2, q) * inv;
          // track polygons win ties with the ground plane they sit on
          if (t >= 0 && t <= maxT && (!best || t < best.t - 1e-6 || (best.surf === this.groundSurf && !best.tri && t <= best.t + 0.02))) best = { t, n: V.dot(tr.n, d) > 0 ? V.scale(tr.n, -1) : tr.n, surf: tr.surf, tri: true, guide: tr.guide, idx: i };
        }
      }
      if (best) best.p = V.madd(o, d, best.t);
      return best;
    }
  }

  class Car {
    constructor(spec, world) {
      this.spec = spec; this.world = world;
      this.mass = 1450 * (spec.mass / 33);
      const L = 4.3, Wd = 1.9, Hh = 1.1, m = this.mass;
      this.invI = [12 / (m * (Hh * Hh + L * L)), 12 / (m * (Wd * Wd + L * L)), 12 / (m * (Wd * Wd + Hh * Hh))];
      // wheel hubs from the simd (physical units / 64 = shape units), z mirrored into Three.js
      this.wheels = spec.wheels.map((w, i) => ({
        mount: [w[0] / 64 * SCALE, 0.42, -w[2] / 64 * SCALE], front: w[2] > 0, rear: w[2] < 0,
        comp: 0, prevComp: 0, spin: 0, steer: 0, contact: null, slip: 0, load: 0,
      }));
      this.radius = 0.22; this.rest = 0.3; this.k = 52000; this.c = 4800;
      this.cog = [0, 0.38, 0];
      this.gearRatios = spec.gearRatio.slice(1, 1 + spec.numGears).map(g => g / 10000);
      this.finalDrive = 2.9;
      this.torqueScale = 7.8;                 // simd torque table to newton-metres
      this.mu = 0.55 + spec.grip / 256 * 0.6;
      this.drag = 0.016 * spec.aeroResistance;
      this.brakeForce = 16000 * (spec.braking / 256);
      this.reset([0, 1, 0], 0);
    }
    reset(pos, yaw) {
      this.pos = pos.slice(); this.vel = [0, 0, 0]; this.w = [0, 0, 0];
      this.q = Q.axisAngle([0, 1, 0], yaw);
      this.gear = 1; this.rpm = this.spec.idleRpm; this.shiftTimer = 0; this.steer = 0;
      this.crashed = false; this.airTime = 0; this.speed = 0; this.surface = SURF_ROAD;
      for (const w of this.wheels) { w.comp = w.prevComp = 0; w.contact = null; }
    }
    torqueAt(rpm) {
      const t = this.spec.torque, f = rpm / 128, i = Math.floor(f);
      if (i < 0) return t[0]; if (i >= t.length - 1) return 0;
      return t[i] + (t[i + 1] - t[i]) * (f - i);
    }
    local(v) { return Q.rotate(this.q, v); }
    step(dt, inp) {
      if (this.crashed) return;
      const up = this.local([0, 1, 0]), fwd = this.local([0, 0, -1]), right = this.local([1, 0, 0]);
      const vLong = V.dot(this.vel, fwd);
      this.speed = vLong;
      // steering: quicker at low speed, gentler at high speed
      const maxSteer = 0.62 / (1 + Math.abs(vLong) / 22);
      const target = inp.steer * maxSteer;
      this.steer += Math.max(-dt * 2.6, Math.min(dt * 2.6, target - this.steer));

      // automatic gearbox using the car's own shift points
      const rears = this.wheels.filter(w => w.rear && w.load > 0);
      const rearSpin = rears.length ? rears.reduce((s, w) => s + (w.spinRate || 0), 0) / rears.length : vLong / this.radius;
      if (inp.reverse) this.gear = -1;
      else if (this.gear === -1 && !inp.reverse) this.gear = 1;
      const ratio = this.gear === -1 ? this.gearRatios[0] * 1.1 : this.gearRatios[this.gear - 1];
      const wheelRpm = Math.abs(rearSpin) * 60 / (2 * Math.PI);
      this.rpm = Math.max(this.spec.idleRpm, wheelRpm * ratio * this.finalDrive);
      if (this.shiftTimer > 0) this.shiftTimer -= dt;
      else if (this.gear > 0) {
        if (this.rpm > this.spec.upshiftRpm && this.gear < this.gearRatios.length) { this.gear++; this.shiftTimer = 0.18; }
        else if (this.rpm < this.spec.downshiftRpm * 0.62 && this.gear > 1) { this.gear--; this.shiftTimer = 0.12; }
      }
      const limiter = this.rpm >= this.spec.maxRpm ? 0 : 1;
      const engineT = this.torqueAt(Math.min(this.rpm, this.spec.maxRpm)) * this.torqueScale * limiter;
      const throttle = this.shiftTimer > 0 ? 0 : inp.throttle;
      const driveF = engineT * ratio * this.finalDrive / this.radius * 0.85 * throttle * (this.gear === -1 ? -1 : 1);

      let F = [0, -G * this.mass, 0], Tq = [0, 0, 0], grounded = 0;
      const applyAt = (f, p) => { F = V.add(F, f); Tq = V.add(Tq, V.cross(V.sub(p, this.pos), f)); };
      const comW = V.add(this.pos, this.local(this.cog));
      const mus = this.spec.surfaceGrip;

      for (const w of this.wheels) {
        const mount = V.add(this.pos, this.local(w.mount));
        const o = V.madd(mount, up, 0.6), dir = V.scale(up, -1), maxT = 0.6 + this.rest + this.radius;
        const hit = this.world.raycast(o, dir, maxT);
        w.prevComp = w.comp;
        if (!hit) { w.load = 0; w.comp = 0; w.spinRate = (w.spinRate || 0) * 0.995; continue; }
        grounded++;
        w.comp = maxT - hit.t;
        const rate = w.prevComp > 0 ? Math.max(-4, Math.min(4, (w.comp - w.prevComp) / dt)) : 0;
        // landing much faster than the springs can take is a crash, as in the original
        if (w.prevComp === 0 && this.airTime > 0.25 && -V.dot(this.vel, hit.n) > 13) { this.crash('landing'); return; }
        const COMP_MAX = 0.24;
        let fz = Math.max(0, Math.min(this.k * Math.min(w.comp, COMP_MAX) + this.c * rate, 70000));
        if (w.comp > COMP_MAX) this.bottomOut(hit, w.comp - COMP_MAX, comW);
        w.load = fz;
        const n = hit.n;
        // wheel heading: front wheels steer about the car's up axis
        let wf = w.front ? V.add(V.scale(fwd, Math.cos(this.steer)), V.scale(right, Math.sin(this.steer))) : fwd;
        wf = V.norm(V.madd(wf, n, -V.dot(wf, n)));
        const wl = V.cross(wf, n);
        const cp = hit.p;
        const vc = V.add(this.vel, V.cross(this.w, V.sub(cp, comW)));
        const vl = V.dot(vc, wf), vs = V.dot(vc, wl);
        const surfIdx = Math.min(4, hit.surf + 1);
        const mu = this.mu * (mus[surfIdx] || 128) / 256;
        let fLong = 0;
        if (w.rear) fLong += driveF / 2;
        if (inp.brake > 0) fLong -= Math.sign(vl) * Math.min(this.brakeForce * inp.brake * (w.front ? 0.3 : 0.2), Math.abs(vl) * this.mass * 2);
        if (inp.handbrake && w.rear) fLong -= Math.sign(vl) * Math.min(6000, Math.abs(vl) * this.mass);
        fLong -= vl * (hit.surf === SURF_GRASS ? 45 : 6);
        let fLat = -vs * 11000;
        if (inp.handbrake && w.rear) fLat *= 0.35;
        const lim = mu * fz, tot = Math.hypot(fLong, fLat);
        w.slip = tot > lim ? Math.min(1, (tot - lim) / (lim + 1)) + 0.2 : Math.abs(vs) > 3 ? 0.2 : 0;
        if (tot > lim && tot > 0) { fLong *= lim / tot; fLat *= lim / tot; }
        // suspension pushes at the contact patch; grip forces act at the centre of mass height so cornering
        // and braking don't tip the car over (Stunts cars never roll from steering alone)
        applyAt(V.scale(n, fz), cp);
        applyAt(V.add(V.scale(wf, fLong), V.scale(wl, fLat)), V.madd(cp, n, V.dot(V.sub(comW, cp), n)));
        w.spinRate = vl / this.radius + (w.rear && throttle && tot > lim ? 25 * throttle : 0);
        this.surface = hit.surf;
        // loops hold the car on their centre line (the original treats loops as their own physical model)
        if (hit.guide) {
          const g = hit.guide, e = V.dot(V.sub(cp, g.point), g.axis), ve = V.dot(this.vel, g.axis);
          applyAt(V.scale(g.axis, -(e * 2600 + ve * 900)), comW);
        }
      }
      for (const w of this.wheels) w.spin += (w.spinRate || 0) * dt;

      // aero drag and a little downforce
      const sp = V.len(this.vel);
      F = V.madd(F, this.vel, -this.drag * sp);
      F = V.madd(F, up, -0.6 * sp * sp * (grounded ? 1 : 0));
      this.airTime = grounded ? 0 : this.airTime + dt;

      // integrate (semi-implicit Euler)
      this.vel = V.madd(this.vel, F, dt / this.mass);
      const tl = Q.rotate(Q.conj(this.q), Tq);
      const dwl = [tl[0] * this.invI[0], tl[1] * this.invI[1], tl[2] * this.invI[2]];
      this.w = V.madd(this.w, this.local(dwl), dt);
      this.w = V.scale(this.w, grounded ? 0.999 : 0.9995);
      this.pos = V.madd(this.pos, this.vel, dt);
      this.q = Q.integrate(this.q, this.w, dt);

      this.bodyCollide(dt, up, fwd, right);
    }
    // Suspension fully compressed: treat the wheel as a rigid contact. Remove the velocity into the
    // surface at the contact point with an impulse and push the body back out. Stable at loop speeds.
    bottomOut(hit, depth, comW) {
      const n = hit.n, r = V.sub(hit.p, comW);
      const vc = V.add(this.vel, V.cross(this.w, r)), vn = V.dot(vc, n);
      if (vn < 0) {
        const rn = V.cross(r, n), rnL = Q.rotate(Q.conj(this.q), rn);
        const iw = this.local([rnL[0] * this.invI[0], rnL[1] * this.invI[1], rnL[2] * this.invI[2]]);
        const denom = 1 / this.mass + V.dot(V.cross(iw, r), n);
        const j = -vn / denom;
        this.vel = V.madd(this.vel, n, j / this.mass);
        this.w = V.madd(this.w, iw, j);
      }
      this.pos = V.madd(this.pos, n, Math.min(depth, 0.3) * 0.5);
    }
    // Body against walls: short horizontal probes from the car body; a fast hit is a crash
    bodyCollide(dt, up, fwd, right) {
      const c = V.add(this.pos, this.local([0, 0.45, 0]));
      const probes = [[fwd, 2.15], [V.scale(fwd, -1), 2.1], [right, 0.95], [V.scale(right, -1), 0.95]];
      for (const [d, len] of probes) {
        const hit = this.world.raycast(c, d, len);
        if (!hit || Math.abs(V.dot(hit.n, up)) > 0.7) continue;
        const into = -V.dot(this.vel, hit.n);
        if (into > 0) {
          if (into > 14) { this.crash('wall'); return; }
          this.vel = V.madd(this.vel, hit.n, into * 1.3);
        }
        this.pos = V.madd(this.pos, hit.n, (len - hit.t) * 0.9);
      }
      // roof touching anything is a crash; in a loop the roof points at empty space, so this still works there
      const roof = this.world.raycast(c, up, 0.85);
      if (roof) this.crash('roof');
    }
    crash(why) { this.crashed = why; this.vel = [0, 0, 0]; this.w = [0, 0, 0]; }
    get kmh() { return Math.abs(this.speed) * 3.6; }
  }

  root.StuntsPhysics = { Car, CollisionWorld, SCALE, SURF_ROAD, SURF_DIRT, SURF_ICE, SURF_GRASS };
})(typeof window !== 'undefined' ? window : globalThis);
