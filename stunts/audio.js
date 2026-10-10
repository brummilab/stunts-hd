// Engine, skid and crash sounds in a PC-speaker-ish style. Starts muted; only plays after a click.
'use strict';
(function (root) {
  class StuntsAudio {
    constructor() { this.muted = true; this.ctx = null; }
    start() {
      if (this.ctx) { this.ctx.resume(); return; }
      try {
        const C = this.ctx = new (root.AudioContext || root.webkitAudioContext)();
        this.master = C.createGain(); this.master.gain.value = 0; this.master.connect(C.destination);
        this.eng = C.createOscillator(); this.eng.type = 'square';
        this.eng2 = C.createOscillator(); this.eng2.type = 'sawtooth';
        const lp = C.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900;
        this.engGain = C.createGain(); this.engGain.gain.value = 0.05;
        this.eng.connect(lp); this.eng2.connect(lp); lp.connect(this.engGain); this.engGain.connect(this.master);
        const n = C.createBuffer(1, C.sampleRate, C.sampleRate), d = n.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
        this.noise = C.createBufferSource(); this.noise.buffer = n; this.noise.loop = true;
        const bp = C.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1800; bp.Q.value = 3;
        this.skid = C.createGain(); this.skid.gain.value = 0;
        this.noise.connect(bp); bp.connect(this.skid); this.skid.connect(this.master);
        this.eng.start(); this.eng2.start(); this.noise.start();
      } catch (e) { this.ctx = null; }
    }
    setMuted(m) { this.muted = m; if (!m) this.start(); }
    update(car) {
      if (!this.ctx) return;
      const t = this.ctx.currentTime;
      this.master.gain.setTargetAtTime(this.muted ? 0 : 0.5, t, 0.05);
      const f = 25 + car.rpm / 60 * 2;           // two firing pulses per revolution
      this.eng.frequency.setTargetAtTime(f, t, 0.03);
      this.eng2.frequency.setTargetAtTime(f / 2, t, 0.03);
      const slip = car.crashed ? 0 : Math.max(...car.wheels.map(w => w.load > 0 ? w.slip : 0));
      this.skid.gain.setTargetAtTime(slip > 0.3 && Math.abs(car.speed) > 3 ? 0.035 : 0, t, 0.04);
    }
    crash() {
      if (!this.ctx || this.muted) return;
      const C = this.ctx, g = C.createGain(), s = C.createBufferSource();
      s.buffer = this.noise.buffer; g.gain.setValueAtTime(0.25, C.currentTime); g.gain.exponentialRampToValueAtTime(0.001, C.currentTime + 1.2);
      s.connect(g); g.connect(this.master); s.start(); s.stop(C.currentTime + 1.3);
    }
  }
  root.StuntsAudio = StuntsAudio;
})(window);
