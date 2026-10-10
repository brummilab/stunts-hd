// Three.js scene for a Stunts track: original shapes placed per trackscene.js, sky and ground per
// horizon type, plus car models with steerable, spinning wheels.
'use strict';
(function (root) {
  const T = () => root.THREE;
  const ANG = 2 * Math.PI / 1024;

  class StuntsWorld {
    constructor(assets, renderer) {
      this.A = assets; this.renderer = renderer; this.scale = root.StuntsPhysics ? root.StuntsPhysics.SCALE : 1;
      const THREE = T();
      this.scene = new THREE.Scene();
      this.lit = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, flatShading: true });
      this.flat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
      this.lineMat = new THREE.LineBasicMaterial({ vertexColors: true });
      this.hemi = new THREE.HemisphereLight(0xffffff, 0x8a8a7a, 0.62);
      this.sun = new THREE.DirectionalLight(0xfff2dc, 0.62);
      this.sun.castShadow = true;
      const sc = this.sun.shadow.camera; sc.left = -70; sc.right = 70; sc.top = 70; sc.bottom = -70; sc.near = 5; sc.far = 600;
      this.sun.shadow.mapSize.set(2048, 2048); this.sun.shadow.bias = -0.0004;
      this.scene.add(this.hemi, this.sun, this.sun.target);
      this.classic = true; this.hemi.visible = this.sun.visible = false;
    }
    material() { return this.classic ? this.flat : this.lit; }
    setClassic(on) {
      this.classic = on;
      this.scene.traverse(o => { if (o.isMesh && o.userData.stunts) o.material = this.material(); });
      this.hemi.visible = this.sun.visible = !on;
    }
    meshFor(geo) {
      const THREE = T(), grp = new THREE.Group();
      const m = new THREE.Mesh(geo.mesh, this.material()); m.userData.stunts = true; m.castShadow = m.receiveShadow = true; grp.add(m);
      if (geo.lines) grp.add(new THREE.LineSegments(geo.lines, this.lineMat));
      return grp;
    }
    buildTrack(trk) {
      const THREE = T();
      if (this.track) this.scene.remove(this.track);
      const S = root.StuntsTrack.buildScene(this.A.tables, trk);
      this.layout = S;
      const g = this.track = new THREE.Group();
      for (const p of S.place) {
        if (!this.A.shapes[p.shape]) continue;
        const o = this.meshFor(this.A.cached(p.shape, p.paint));
        o.position.set(p.x, p.y + (p.kind === 'terrain' ? 0 : 0.6), -p.z);
        o.rotation.y = -p.rot * ANG;
        if (p.kind === 'terrain') o.children[0].castShadow = false;
        g.add(o);
      }
      const H = this.horizon;
      const c3 = a => new THREE.Color(a[0], a[1], a[2]);
      const ground = new THREE.Mesh(new THREE.PlaneGeometry(400000, 400000), new THREE.MeshBasicMaterial({ color: c3(H.ground) }));
      ground.rotation.x = -Math.PI / 2; ground.position.set(15360, -1.5, -15360);
      ground.userData.ground = true;
      g.add(ground);
      g.scale.setScalar(this.scale);
      this.scene.add(g);
      // flat sky colour, as the original fills above the horizon line
      this.scene.background = c3(H.sky);
      this.scene.fog = null;
      this.buildHorizon(H);
      return S;
    }
    // The horizon art as a band around the viewer at a fixed distance, so it never gets closer.
    // 1024 px = 360 degrees around; vertically a strip pixel is about 0.28 degrees, matching how tall the
    // strip sits on the original 320x200 screen.
    buildHorizon(H) {
      const THREE = T();
      if (this.horizonMesh) this.scene.remove(this.horizonMesh);
      const c = document.createElement('canvas'); c.width = H.w; c.height = H.h; c.getContext('2d').putImageData(H.img, 0, 0);
      const tex = new THREE.CanvasTexture(c); tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.NearestFilter;
      tex.wrapS = THREE.RepeatWrapping;
      const R = 4000, h = R * Math.tan(H.h * 0.28 * Math.PI / 180);
      const geo = new THREE.CylinderGeometry(R, R, h, 256, 1, true);
      const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, alphaTest: 0.5, side: THREE.BackSide, depthWrite: false, fog: false });
      const m = this.horizonMesh = new THREE.Mesh(geo, mat);
      m.renderOrder = -1; m.frustumCulled = false; m.userData.h = h;
      this.scene.add(m);
    }
    followCamera(cam) {
      if (this.horizonMesh) this.horizonMesh.position.set(cam.position.x, this.horizonMesh.userData.h / 2 - 2, cam.position.z);
    }
    // A car model: body plus four wheel pivots that can steer and spin
    carModel(car, paint) {
      const THREE = T();
      const geo = this.A.geometry(car.shape, paint, { splitWheels: true, lift: 0.08 });
      const root3 = new THREE.Group();
      const body = this.meshFor(geo); root3.add(body);
      root3.wheels = geo.wheels.map(w => {
        const pivot = new THREE.Group();
        const mid = [(w.a[0] + w.b[0]) / 2, (w.a[1] + w.b[1]) / 2, (w.a[2] + w.b[2]) / 2];
        pivot.position.set(...mid);
        const spin = new THREE.Group(); pivot.add(spin);
        const len = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1], w.b[2] - w.a[2]);
        const tyre = new THREE.Mesh(new THREE.CylinderGeometry(w.r, w.r, len, 10), this.material());
        tyre.material = new THREE.MeshLambertMaterial({ color: new THREE.Color(...w.c), flatShading: true });
        tyre.rotation.z = Math.PI / 2; tyre.castShadow = true;
        const hub = new THREE.Mesh(new THREE.CylinderGeometry(w.r * 0.5, w.r * 0.5, len * 1.02, 6), new THREE.MeshLambertMaterial({ color: 0x9a9a9a, flatShading: true }));
        hub.rotation.z = Math.PI / 2;
        spin.add(tyre, hub);
        pivot.spin = spin; pivot.front = mid[2] < 0; // shape z is mirrored, so front wheels have negative z
        root3.add(pivot);
        return pivot;
      });
      root3.scale.setScalar(this.scale);
      return root3;
    }
  }
  root.StuntsWorld = StuntsWorld; root.STUNTS_ANG = ANG;
})(window);
