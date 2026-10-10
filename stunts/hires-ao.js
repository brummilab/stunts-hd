// Screen-space ambient occlusion for the modern view: corners, kerbs, the ground under cars and bridges
// darken the way they do in sunlight. The scene's view-space positions go to a float target (half
// resolution); a hemisphere of samples around each pixel's face normal is tested against them; the
// result, smoothed with a depth-aware blur, multiplies the frame already drawn on the canvas.
'use strict';
(function (root) {
  const T = root.THREE;
  const quadVS = 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';

  class AO {
    constructor(renderer, { radius = 9, strength = 0.75, samples = 16 } = {}) {
      this.r = renderer; this.radius = radius; this.strength = strength;
      const gl = renderer.getContext(), float = renderer.capabilities.isWebGL2 && gl.getExtension('EXT_color_buffer_float');
      const opt = { type: float ? T.FloatType : T.HalfFloatType, format: T.RGBAFormat, minFilter: T.NearestFilter, magFilter: T.NearestFilter, depthBuffer: true };
      this.pos = new T.WebGLRenderTarget(4, 4, opt);
      this.ao = new T.WebGLRenderTarget(4, 4, { type: T.HalfFloatType, format: T.RGBAFormat, minFilter: T.LinearFilter, magFilter: T.LinearFilter, depthBuffer: false });
      // view-space position (a = 1 where there is geometry)
      this.posMat = new T.ShaderMaterial({
        side: T.DoubleSide,
        vertexShader: `#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vView;
void main() {
  #include <begin_vertex>
  #include <project_vertex>
  #include <logdepthbuf_vertex>
  vView = mvPosition.xyz;
}`,
        fragmentShader: `#include <logdepthbuf_pars_fragment>
varying vec3 vView;
void main() {
  #include <logdepthbuf_fragment>
  gl_FragColor = vec4(vView, 1.0);
}`,
      });
      // kernel: points in the unit hemisphere (z up), denser near the centre
      const K = [];
      for (let i = 0; i < samples; i++) {
        const a = i * 2.39996 + 0.4, z = 0.15 + 0.85 * ((i + 0.5) / samples), rr = Math.sqrt(1 - z * z);
        const s = 0.25 + 0.75 * Math.pow((i + 1) / samples, 2);
        K.push(new T.Vector3(Math.cos(a) * rr * s, Math.sin(a) * rr * s, z * s));
      }
      this.aoMat = new T.ShaderMaterial({
        depthTest: false, depthWrite: false,
        uniforms: { tPos: { value: this.pos.texture }, proj: { value: new T.Matrix4() }, kernel: { value: K }, radius: { value: radius }, size: { value: new T.Vector2() } },
        vertexShader: quadVS,
        fragmentShader: `uniform sampler2D tPos; uniform mat4 proj; uniform vec3 kernel[${samples}]; uniform float radius; uniform vec2 size; varying vec2 vUv;
float rnd(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  vec4 P = texture2D(tPos, vUv);
  if (P.a < 0.5) { gl_FragColor = vec4(1.0); return; }
  // face normal from the neighbouring positions (the smaller step on each axis keeps edges sharp)
  vec2 px = 1.0 / size;
  vec3 r = texture2D(tPos, vUv + vec2(px.x, 0.0)).xyz - P.xyz, l = P.xyz - texture2D(tPos, vUv - vec2(px.x, 0.0)).xyz;
  vec3 u = texture2D(tPos, vUv + vec2(0.0, px.y)).xyz - P.xyz, d = P.xyz - texture2D(tPos, vUv - vec2(0.0, px.y)).xyz;
  vec3 dx = abs(r.z) < abs(l.z) ? r : l, dy = abs(u.z) < abs(d.z) ? u : d;
  vec3 N = normalize(cross(dx, dy));
  if (dot(N, P.xyz) > 0.0) N = -N;
  // a random rotation per pixel around the normal (the blur evens it out)
  float a = rnd(gl_FragCoord.xy) * 6.2831853;
  vec3 rv = vec3(cos(a), sin(a), 0.0);
  vec3 Tn = normalize(rv - N * dot(rv, N)), B = cross(N, Tn);
  mat3 TBN = mat3(Tn, B, N);
  float R = radius * clamp(-P.z / 300.0, 1.0, 8.0);   // a wider reach far away (big shapes), never below the near scale
  float occ = 0.0;
  for (int i = 0; i < ${samples}; i++) {
    vec3 S = P.xyz + TBN * kernel[i] * R;
    vec4 c = proj * vec4(S, 1.0);
    vec2 uv = c.xy / c.w * 0.5 + 0.5;
    vec4 Q = texture2D(tPos, uv);
    if (Q.a < 0.5) continue;
    float range = smoothstep(0.0, 1.0, R / abs(P.z - Q.z));
    occ += (Q.z >= S.z + R * 0.04 ? 1.0 : 0.0) * range;
  }
  float ao = 1.0 - occ / ${samples}.0;
  ao = mix(ao, 1.0, smoothstep(9000.0, 20000.0, -P.z));   // far away: none
  gl_FragColor = vec4(ao, P.z, 0.0, 1.0);
}`,
      });
      // depth-aware blur, then multiply onto the frame
      this.outMat = new T.ShaderMaterial({
        depthTest: false, depthWrite: false, transparent: true,
        blending: T.CustomBlending, blendEquation: T.AddEquation, blendSrc: T.ZeroFactor, blendDst: T.SrcColorFactor,
        uniforms: { tAO: { value: this.ao.texture }, size: { value: new T.Vector2() }, strength: { value: strength } },
        vertexShader: quadVS,
        fragmentShader: `uniform sampler2D tAO; uniform vec2 size; uniform float strength; varying vec2 vUv;
void main() {
  vec2 c = texture2D(tAO, vUv).xy; float s = 0.0, w = 0.0;
  for (int y = -2; y <= 2; y++) for (int x = -2; x <= 2; x++) {
    vec2 q = texture2D(tAO, vUv + vec2(float(x), float(y)) / size).xy;
    float k = 1.0 / (1.0 + abs(q.y - c.y) * 0.25);
    s += q.x * k; w += k;
  }
  float ao = s / w;
  gl_FragColor = vec4(vec3(mix(1.0, ao, strength)), 1.0);
}`,
      });
      this.scene = new T.Scene(); this.quadCam = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      this.quad = new T.Mesh(new T.PlaneGeometry(2, 2), this.aoMat); this.quad.frustumCulled = false;
      this.scene.add(this.quad);
    }
    // scene drawn into the canvas already; hide: objects not to count (shadow casters, see-through things)
    render(scene, cam, hide) {
      const r = this.r, sz = r.getDrawingBufferSize(new T.Vector2()), w = Math.max(1, sz.x >> 1), h = Math.max(1, sz.y >> 1);
      if (this.pos.width !== w || this.pos.height !== h) { this.pos.setSize(w, h); this.ao.setSize(w, h); }
      const vis = hide.map(o => o.visible), prevO = scene.overrideMaterial, prevBg = scene.background, prevT = r.getRenderTarget();
      const cc = r.getClearColor(new T.Color()), ca = r.getClearAlpha(), sm = r.shadowMap.autoUpdate;
      hide.forEach(o => { o.visible = false; });
      scene.overrideMaterial = this.posMat; r.shadowMap.autoUpdate = false;
      r.setRenderTarget(this.pos); r.setClearColor(0x000000, 0); r.clear(); r.render(scene, cam);
      scene.overrideMaterial = prevO; hide.forEach((o, i) => { o.visible = vis[i]; });
      this.aoMat.uniforms.proj.value.copy(cam.projectionMatrix); this.aoMat.uniforms.size.value.set(w, h); this.aoMat.uniforms.radius.value = this.radius;
      this.quad.material = this.aoMat; r.setRenderTarget(this.ao); r.render(this.scene, this.quadCam);
      r.setRenderTarget(prevT); r.setClearColor(cc, ca); r.shadowMap.autoUpdate = sm;
      this.outMat.uniforms.size.value.set(w, h); this.outMat.uniforms.strength.value = this.strength;
      this.quad.material = this.outMat; r.render(this.scene, this.quadCam);
    }
  }
  root.StuntsAO = AO;
})(window);
