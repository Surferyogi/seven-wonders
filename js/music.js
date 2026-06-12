/* Seven Wonders — original procedural soundtrack (WebAudio)
   100% code-generated, original composition. No audio files, no samples,
   nothing licensed — so it caches offline for free and weighs 0 bytes.
   Mood: ancient-world ambient in D double-harmonic, ~80 BPM. */
(function () {
  'use strict';

  const Music = {
    ctx: null,
    musicOn: true,
    sfxOn: true,
    started: false,
    _timer: null,
    _nextNoteTime: 0,
    _step: 0,
    _musicGain: null,
    _sfxGain: null,
    _delay: null,

    /* ---- composition data (original) ----
       D double-harmonic scale, MIDI numbers. 0 = rest.
       Four 16-step phrases (eighth notes) arranged A A B C. */
    BPM: 80,
    phrases: [
      [62, 0, 66, 67, 69, 0, 70, 69, 67, 66, 0, 63, 62, 0, 0, 0],
      [62, 0, 66, 67, 69, 0, 70, 69, 67, 66, 0, 63, 62, 0, 0, 0],
      [69, 0, 70, 73, 74, 0, 73, 70, 69, 67, 66, 67, 62, 0, 0, 0],
      [67, 0, 66, 63, 62, 0, 63, 66, 67, 0, 69, 0, 62, 0, 0, 0],
    ],
    // sparse frame-drum pattern per 16 steps: 1 = doum (low), 2 = tek (high)
    drums: [1, 0, 0, 0, 2, 0, 1, 0, 0, 0, 1, 0, 2, 0, 0, 0],

    init() {
      if (this.ctx) return;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this._musicGain = this.ctx.createGain();
      this._musicGain.gain.value = this.musicOn ? 0.5 : 0;
      this._sfxGain = this.ctx.createGain();
      this._sfxGain.gain.value = this.sfxOn ? 1 : 0;
      // gentle echo bus for the melody
      this._delay = this.ctx.createDelay(1.5);
      this._delay.delayTime.value = 0.42;
      const fb = this.ctx.createGain(); fb.gain.value = 0.3;
      const wet = this.ctx.createGain(); wet.gain.value = 0.25;
      this._delay.connect(fb); fb.connect(this._delay);
      this._delay.connect(wet); wet.connect(this._musicGain);
      this._musicGain.connect(this.ctx.destination);
      this._sfxGain.connect(this.ctx.destination);
    },

    /* must be called from a user gesture (browser autoplay policy) */
    start() {
      this.init();
      if (!this.ctx) return;
      if (this.ctx.state === 'suspended') this.ctx.resume();
      if (this.started) return;
      this.started = true;
      this._startDrone();
      this._nextNoteTime = this.ctx.currentTime + 0.1;
      this._step = 0;
      const lookahead = () => {
        const ahead = 0.12;
        while (this._nextNoteTime < this.ctx.currentTime + ahead) {
          this._scheduleStep(this._step, this._nextNoteTime);
          this._nextNoteTime += (60 / this.BPM) / 2; // eighth notes
          this._step = (this._step + 1) % (this.phrases.length * 16);
        }
        this._timer = setTimeout(lookahead, 30);
      };
      lookahead();
    },

    _startDrone() {
      const t = this.ctx.currentTime;
      const mk = (freq, gainV) => {
        const o = this.ctx.createOscillator();
        o.type = 'triangle'; o.frequency.value = freq;
        const f = this.ctx.createBiquadFilter();
        f.type = 'lowpass'; f.frequency.value = 320; f.Q.value = 0.6;
        const g = this.ctx.createGain(); g.gain.value = gainV;
        // slow breathing LFO
        const lfo = this.ctx.createOscillator(); lfo.frequency.value = 0.07 + Math.random() * 0.04;
        const lg = this.ctx.createGain(); lg.gain.value = gainV * 0.35;
        lfo.connect(lg); lg.connect(g.gain);
        o.connect(f); f.connect(g); g.connect(this._musicGain);
        o.start(t); lfo.start(t);
      };
      mk(73.42, 0.10);   // D2
      mk(110.0, 0.06);   // A2
      mk(146.83, 0.035); // D3
    },

    _midiHz(m) { return 440 * Math.pow(2, (m - 69) / 12); },

    _scheduleStep(step, when) {
      const bar = Math.floor(step / 16), s = step % 16;
      const note = this.phrases[bar][s];
      if (note > 0) {
        // plucked melody voice
        const o = this.ctx.createOscillator();
        o.type = 'triangle';
        o.frequency.value = this._midiHz(note);
        const g = this.ctx.createGain();
        const vel = 0.16 + Math.random() * 0.05;
        g.gain.setValueAtTime(0.0001, when);
        g.gain.exponentialRampToValueAtTime(vel, when + 0.015);
        g.gain.exponentialRampToValueAtTime(0.0001, when + 0.55);
        o.connect(g); g.connect(this._musicGain); g.connect(this._delay);
        o.start(when); o.stop(when + 0.7);
      }
      const d = this.drums[s];
      if (d === 1) this._doum(when);
      else if (d === 2 && Math.random() < 0.8) this._tek(when);
    },

    _doum(when) { // low frame-drum hit: sine with fast pitch drop
      const o = this.ctx.createOscillator(); o.type = 'sine';
      o.frequency.setValueAtTime(150, when);
      o.frequency.exponentialRampToValueAtTime(52, when + 0.12);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.22, when);
      g.gain.exponentialRampToValueAtTime(0.0001, when + 0.28);
      o.connect(g); g.connect(this._musicGain);
      o.start(when); o.stop(when + 0.3);
    },

    _tek(when) { // high rim tap: filtered noise burst
      const len = 0.06, sr = this.ctx.sampleRate;
      const buf = this.ctx.createBuffer(1, sr * len, sr);
      const ch = buf.getChannelData(0);
      for (let i = 0; i < ch.length; i++) ch[i] = (Math.random() * 2 - 1) * (1 - i / ch.length);
      const src = this.ctx.createBufferSource(); src.buffer = buf;
      const f = this.ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 2200;
      const g = this.ctx.createGain(); g.gain.value = 0.10;
      src.connect(f); f.connect(g); g.connect(this._musicGain);
      src.start(when);
    },

    setMusic(on) {
      this.musicOn = on;
      if (this._musicGain) {
        const t = this.ctx.currentTime;
        this._musicGain.gain.cancelScheduledValues(t);
        this._musicGain.gain.linearRampToValueAtTime(on ? 0.5 : 0.0001, t + 0.4);
      }
    },
    setSfx(on) {
      this.sfxOn = on;
      if (this._sfxGain) this._sfxGain.gain.value = on ? 1 : 0;
    },

    /* short UI/game sound effects, routed through the SFX bus */
    beep(freq, dur = 0.08, type = 'triangle', gain = 0.05) {
      if (!this.sfxOn) return;
      try {
        this.init();
        if (!this.ctx) return;
        if (this.ctx.state === 'suspended') this.ctx.resume();
        const o = this.ctx.createOscillator(), g = this.ctx.createGain();
        o.type = type; o.frequency.value = freq;
        g.gain.setValueAtTime(gain, this.ctx.currentTime);
        g.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + dur);
        o.connect(g); g.connect(this._sfxGain);
        o.start(); o.stop(this.ctx.currentTime + dur);
      } catch (e) { /* audio unavailable */ }
    },
  };

  window.SWMusic = Music;
})();
