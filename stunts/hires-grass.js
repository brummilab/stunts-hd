// Grass for the modern view: instanced blades in a disc around the camera. Where they may grow, and how
// high, comes from a top-down render of the scene into a float texture (height of the top surface and its
// colour; only green surfaces count), so grass follows plateaus and slopes and stays off roads, kerbs and
// buildings. Blades sit on a grid of cells that moves with the camera in whole cells, so they stay put
// in the world; each cell varies its blades by its world coordinates.
'use strict';
(function (root) {
  const T = root.THREE;

  class Grass {
    // R: radius, CELL: cell size, PER: blades per cell, SIZE: blade scale, R0: inner radius (nothing inside),
    // MAPN: height map texels
    constructor(renderer, scene, { R = 820, CELL = 32, PER = 60, SIZE = 1, R0 = 0, FADE = 0.3, MAPN = 512, every = 6 } = {}) {
      const MAPW = 2 * R + 2 * CELL;
      Object.assign(this, { R, CELL, MAPW, every });
      this.r = renderer;
      // height map pass
      this.target = new T.WebGLRenderTarget(MAPN, MAPN, { type: T.HalfFloatType, format: T.RGBAFormat, minFilter: T.NearestFilter, magFilter: T.NearestFilter, depthBuffer: true });
      this.mapCam = new T.OrthographicCamera(-MAPW / 2, MAPW / 2, MAPW / 2, -MAPW / 2, 1, 40000);
      this.mapCam.up.set(0, 0, -1);
      this.mapCam.layers.set(1);
      this.mapMat = new T.ShaderMaterial({
        vertexColors: true, side: T.DoubleSide,
        uniforms: { groundColor: { value: new T.Color() } },
        vertexShader: `#include <common>
#include <color_pars_vertex>
attribute float rank;
varying float vY; varying vec3 vC;
void main() {
  #include <color_vertex>
  #include <begin_vertex>
  vec3 tr0 = transformed;
  transformed.y += rank * 0.08;   // the same layering as the depth bias: roads over pads, the ground plane lowest
  #include <project_vertex>
  vec4 wp = vec4(tr0, 1.0);
  #ifdef USE_INSTANCING
  wp = instanceMatrix * wp;
  #endif
  wp = modelMatrix * wp;
  vY = wp.y; vC = vColor;
}`,
        fragmentShader: `uniform vec3 groundColor; varying float vY; varying vec3 vC;
void main() {
  vec3 c = vC;
  if (c.r > 0.99 && c.g > 0.99 && c.b > 0.99) c = groundColor;   // the ground plane
  bool green = c.g > c.r * 1.15 && c.g > c.b * 1.15;
  gl_FragColor = green ? vec4(vY, c.r, c.g, c.b + 1.0) : vec4(0.0);   // a > 0: grass
}`,
      });
      this.mapScene = scene;
      this.mapAt = new T.Vector2(1e9, 1e9); this.mapAge = 0;

      // blades
      const n = Math.ceil(2 * R / CELL) ** 2 * PER;
      const g = new T.InstancedBufferGeometry();
      // a tapered blade: base pair, middle pair, tip; (side, height)
      g.setAttribute('position', new T.Float32BufferAttribute([-1, 0, 0, 1, 0, 0, -0.62, 0.55, 0, 0.62, 0.55, 0, 0, 1, 0], 3));
      g.setIndex([0, 1, 2, 1, 3, 2, 2, 3, 4]);
      const cells = Math.ceil(2 * R / CELL), off = new Float32Array(n * 4);
      let k = 0;
      for (let cz = 0; cz < cells; cz++) for (let cx = 0; cx < cells; cx++) for (let i = 0; i < PER; i++, k++) {
        off[k * 4] = cx - cells / 2; off[k * 4 + 1] = cz - cells / 2;
        off[k * 4 + 2] = hash(i * 7.13 + 0.31); off[k * 4 + 3] = hash(i * 3.71 + 0.77);   // the same pattern in every cell
      }
      g.setAttribute('cell', new T.InstancedBufferAttribute(off, 4));
      g.instanceCount = n;
      this.mat = new T.ShaderMaterial({
        side: T.DoubleSide,
        uniforms: {
          heightMap: { value: this.target.texture }, MAPFLIP: { value: 1 }, mapOrigin: { value: new T.Vector2() }, mapSize: { value: MAPW },
          origin: { value: new T.Vector2() }, camPos: { value: new T.Vector3() }, time: { value: 0 },
          sunDir: { value: new T.Vector3(0, 1, 0) }, sunColor: { value: new T.Color(1, 1, 1) }, skyColor: { value: new T.Color(0.5, 0.6, 0.7) },
          fogColor: { value: new T.Color() }, fogNear: { value: 9000 }, fogFar: { value: 110000 }, logDepthBufFC: { value: 1 },
        },
        vertexShader: `#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec4 cell;
uniform sampler2D heightMap; uniform float MAPFLIP; uniform vec2 mapOrigin; uniform float mapSize; uniform vec2 origin; uniform vec3 camPos; uniform float time;
varying vec3 vCol; varying float vT; varying float vFog; varying vec3 vN; varying float vFar;
float h1(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
  vec2 cw = origin + cell.xy * ${CELL.toFixed(1)};               // this cell's corner in the world
  float r1 = h1(cw), r2 = h1(cw + 17.0);
  vec2 lo = cell.zw;                                               // vary the shared pattern per cell
  if (r1 > 0.5) lo = lo.yx;
  if (r2 > 0.5) lo.x = 1.0 - lo.x;
  vec2 xz = cw + lo * ${CELL.toFixed(1)};
  vec4 m = texture2D(heightMap, vec2(xz.x - mapOrigin.x, xz.y - mapOrigin.y) * vec2(1.0, MAPFLIP) / mapSize + 0.5);
  float d = distance(xz, camPos.xz);
  float s = h1(xz);
  float keep = step(0.5, m.a) * (1.0 - smoothstep(${(R * FADE).toFixed(1)}, ${R.toFixed(1)}, d)) * smoothstep(${(R0 * 0.85).toFixed(1)}, ${(R0 * 1.15 + 0.001).toFixed(1)}, d);
  float hgt = (5.0 + 7.0 * s) * ${SIZE.toFixed(2)} * keep;
  vFar = smoothstep(${(R * 0.2).toFixed(1)}, ${R.toFixed(1)}, d);
  float wdt = (0.9 + 0.5 * h1(xz + 3.1)) * ${(SIZE * 1.2).toFixed(2)};
  float a = s * 6.2831853;
  vec2 dir = vec2(cos(a), sin(a));
  float t = position.y;
  // wind: gusts travel across the field, the tip bends most
  float gust = sin(time * 1.7 + xz.x * 0.013 + xz.y * 0.009) * 0.6 + sin(time * 3.1 + xz.x * 0.05) * 0.25;
  vec2 bend = vec2(0.8, 0.5) * gust * t * t * hgt * 0.35 + dir.yx * vec2(-1.0, 1.0) * t * t * hgt * 0.25 * (s - 0.5);
  vec3 p = vec3(xz.x + dir.x * position.x * wdt + bend.x, m.r + t * hgt, xz.y + dir.y * position.x * wdt + bend.y);
  vT = t;
  vCol = vec3(m.g, m.b, m.a - 1.0) * (0.92 + 0.22 * h1(xz + 9.0));
  vN = normalize(vec3(-dir.y, 0.6, dir.x));
  vec4 mv = viewMatrix * vec4(p, 1.0);
  gl_Position = keep > 0.0 ? projectionMatrix * mv : vec4(2.0, 2.0, 2.0, 1.0);
  vFog = smoothstep(${'9000.0'}, ${'110000.0'}, -mv.z);
  #include <logdepthbuf_vertex>
}`,
        fragmentShader: `#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 sunDir; uniform vec3 sunColor; uniform vec3 skyColor; uniform vec3 fogColor;
varying vec3 vCol; varying float vT; varying float vFog; varying vec3 vN; varying float vFar;
void main() {
  #include <logdepthbuf_fragment>
  vec3 n = normalize(vN) * (gl_FrontFacing ? 1.0 : -1.0);
  float lit = max(dot(n, sunDir), 0.0) * 0.55 + 0.6;
  vec3 c = vCol * mix(0.62, 1.25, mix(vT, 0.5, vFar)) * (skyColor + sunColor * lit) * 0.7;   // far blades take the ground's mean shade
  c += vec3(0.05, 0.07, 0.0) * vT * vT;                           // sunlit tips
  gl_FragColor = vec4(mix(c, fogColor, vFog), 1.0);
  #include <encodings_fragment>
}`,
      });
      this.mesh = new T.Mesh(g, this.mat);
      this.mesh.frustumCulled = false;
      scene.add(this.mesh);
    }

    update(view, camPos, groundColor, sun, hemi, fog, now, race) {
      this.mesh.visible = race;
      if (!race) return;
      const u = this.mat.uniforms;
      // the height map follows the camera, re-rendered when it has moved or every few frames (moving shapes)
      const CELL = this.CELL;
      const at = new T.Vector2(Math.round(camPos.x / CELL) * CELL, Math.round(camPos.z / CELL) * CELL);
      if (at.distanceTo(this.mapAt) > CELL * 2 || ++this.mapAge > this.every) {
        this.mapAge = 0; this.mapAt.copy(at);
        this.mapCam.position.set(at.x, camPos.y + 20000, at.y); this.mapCam.lookAt(at.x, 0, at.y); this.mapCam.updateMatrixWorld();
        this.mapMat.uniforms.groundColor.value.copy(groundColor);
        const prevT = this.r.getRenderTarget(), prevO = this.mapScene.overrideMaterial, prevBg = this.mapScene.background, prevFog = this.mapScene.fog;
        const cc = this.r.getClearColor(new T.Color()), ca = this.r.getClearAlpha();
        this.mesh.visible = false; this.mapScene.overrideMaterial = this.mapMat; this.mapScene.fog = null;
        this.r.setRenderTarget(this.target); this.r.setClearColor(new T.Color(0, 0, 0), 0); this.r.clear();
        const sm = this.r.shadowMap.autoUpdate; this.r.shadowMap.autoUpdate = false;
        this.r.render(this.mapScene, this.mapCam);
        this.r.shadowMap.autoUpdate = sm;
        this.r.setRenderTarget(prevT); this.r.setClearColor(cc, ca);
        this.mapScene.overrideMaterial = prevO; this.mapScene.background = prevBg; this.mapScene.fog = prevFog; this.mesh.visible = true;
        u.mapOrigin.value.copy(at);
      }
      u.origin.value.set(Math.floor(camPos.x / CELL) * CELL, Math.floor(camPos.z / CELL) * CELL);
      u.camPos.value.copy(camPos); u.time.value = now / 1000;
      u.sunDir.value.copy(sun.position).sub(sun.target.position).normalize();
      u.sunColor.value.copy(sun.color).multiplyScalar(sun.intensity);
      u.skyColor.value.copy(hemi.color).multiplyScalar(hemi.intensity);
      u.fogColor.value.copy(fog.color);
      u.logDepthBufFC.value = 2.0 / (Math.log(400000 + 1.0) / Math.LN2);
    }
  }
  function hash(x) { const s = Math.sin(x * 12.9898) * 43758.5453; return s - Math.floor(s); }
  root.StuntsGrass = Grass;
})(window);
