// 미리보기 재생 엔진: 숨긴 <video>/<audio>를 재생하며 캔버스에 합성, 소리는 WebAudio
import { store } from './store.js';
import { media, thumbAt } from './media.js';
import { clipEnd, srcTime, mediaDur, canvasSize, mainSceneAt, findClip, avClips } from './model.js';
import { renderFrame, imageSource } from './render.js';
import { FPS } from './util.js';

export function fadeGain(c, t) {
  let g = c.volume ?? 1;
  const local = t - c.start, rem = clipEnd(c) - t;
  if (c.fadeIn > 0 && local < c.fadeIn) g *= Math.max(0, local / c.fadeIn);
  if (c.fadeOut > 0 && rem < c.fadeOut) g *= Math.max(0, rem / c.fadeOut);
  return g;
}

// 클립별 미디어 요소를 시간에 맞춰 돌리는 장치(미리보기·실시간 녹화 공용)
export class ElementSync {
  constructor(holder, { audio = true, onFrame } = {}) {
    this.holder = holder; this.audio = audio; this.onFrame = onFrame;
    this.els = new Map(); this.ac = null; this.master = null;
  }
  ensureAudio() {
    if (!this.audio) return;
    if (!this.ac) {
      try {
        this.ac = new (window.AudioContext || window.webkitAudioContext)();
        this.master = this.ac.createGain();
        this.master.connect(this.ac.destination);
        for (const e of this.els.values()) this.connect(e);
      } catch (e) { this.ac = null; }
    }
    if (this.ac && this.ac.state === 'suspended') this.ac.resume().catch(() => {});
  }
  connect(e) {
    if (!this.audio || !this.ac || e.gain) return;
    try {
      const s = this.ac.createMediaElementSource(e.el);
      const g = this.ac.createGain();
      g.gain.value = 0;
      s.connect(g); g.connect(this.master);
      e.gain = g; e.el.muted = false;
    } catch (err) { /* 요소 볼륨으로 대신 */ }
  }
  ensure(c) {
    let e = this.els.get(c.id);
    if (e && e.mediaId === c.mediaId) return e;
    if (e) this.drop(c.id);
    const m = media.get(c.mediaId);
    if (!m) return null;
    const el = document.createElement(c.type === 'audio' ? 'audio' : 'video');
    el.preload = 'auto'; el.playsInline = true; el.muted = true;
    el.src = m.url;
    if (this.onFrame) { el.addEventListener('seeked', this.onFrame); el.addEventListener('loadeddata', this.onFrame); }
    this.holder.append(el);
    e = { el, mediaId: c.mediaId, gain: null };
    this.els.set(c.id, e);
    this.connect(e);
    return e;
  }
  drop(id) {
    const e = this.els.get(id);
    if (!e) return;
    try { e.el.pause(); e.el.removeAttribute('src'); e.el.load(); e.el.remove(); } catch (er) { /* */ }
    this.els.delete(id);
  }
  setVol(e, v) {
    if (e.gain) { e.gain.gain.value = v; }
    else { e.el.muted = v <= 0.001; e.el.volume = Math.max(0, Math.min(1, v)); }
  }
  sync(p, t, playing) {
    const live = new Set();
    for (const tr of p.tracks) {
      for (const c of avClips(tr)) {
        live.add(c.id);
        const lead = playing ? 1.2 : 0.6;
        const near = t >= c.start - lead && t < clipEnd(c) + 0.6;
        const e = near ? this.ensure(c) : this.els.get(c.id);
        if (!e) continue;
        const el = e.el;
        const md = mediaDur(c);
        const want = Math.max(0, Math.min(isFinite(md) ? md - 0.04 : 1e9, srcTime(c, t)));
        const inside = t >= c.start && t < clipEnd(c);
        const audible = inside && !c.disabled && !c.muted && !tr.muted && !(tr.hidden && c.type !== 'audio');
        this.setVol(e, this.audio && audible ? fadeGain(c, t) : 0);
        if (playing && inside && !c.disabled) {
          if (Math.abs(el.playbackRate - (c.speed || 1)) > 1e-3) el.playbackRate = c.speed || 1;
          if (el.paused) {
            if (Math.abs(el.currentTime - want) > 0.05) el.currentTime = want;
            el.play().catch(() => {});
          } else if (Math.abs(el.currentTime - want) > 0.3 && !el.seeking) {
            el.currentTime = want;
          }
        } else {
          if (!el.paused) el.pause();
          if (!el.seeking && Math.abs(el.currentTime - want) > 0.5 / FPS && el.readyState >= 1) el.currentTime = want;
        }
      }
    }
    for (const id of [...this.els.keys()]) if (!live.has(id)) this.drop(id);
  }
  pauseAll() { for (const e of this.els.values()) { if (!e.el.paused) e.el.pause(); this.setVol(e, 0); } }
  get(clip, t) {
    if (clip.type === 'image') return imageSource(clip);
    const e = this.els.get(clip.id);
    if (e && e.el.readyState >= 2 && e.el.videoWidth) return { img: e.el, w: e.el.videoWidth, h: e.el.videoHeight };
    const m = media.get(clip.mediaId);
    const th = thumbAt(m, srcTime(clip, t));
    return th ? { img: th, w: th.width, h: th.height } : null;
  }
}

export class Player {
  constructor(canvas, holder) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.sync = new ElementSync(holder, { audio: true, onFrame: () => this.requestRender() });
    this.raf = 0; this.pending = false;
    this.k = 1; this.W = 1080; this.H = 1920;
    store.on('time', (src) => { if (src !== 'player') { if (store.playing) this.restartClock(); this.syncNow(); this.requestRender(); } });
    store.on('project', () => { this.syncNow(); this.requestRender(); });
    store.on('render', () => this.requestRender());
  }
  syncNow() { if (store.p) this.sync.sync(store.p, store.t, store.playing); }
  layout(cssW, cssH) {
    const p = store.p;
    if (!p) return;
    const { W, H } = canvasSize(p);
    this.W = W; this.H = H;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const k = Math.min(1, (cssW * dpr) / W);
    const pw = Math.max(2, Math.round(W * k)), ph = Math.max(2, Math.round(H * k));
    if (this.canvas.width !== pw || this.canvas.height !== ph) { this.canvas.width = pw; this.canvas.height = ph; }
    this.k = pw / W;
    this.canvas.style.width = cssW + 'px';
    this.canvas.style.height = cssH + 'px';
    this.requestRender();
  }
  requestRender() {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => { this.pending = false; this.draw(); });
  }
  draw() {
    const p = store.p;
    if (!p) { this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height); return; }
    renderFrame(this.ctx, p, store.t, this.sync, {
      W: this.W, H: this.H, k: this.k, pw: this.canvas.width, ph: this.canvas.height,
      original: store.compare, noAnim: store.mode === 'photo', hideId: store.editingId || null, preview: true,
    });
    store.emit('drawn');
  }
  play() {
    if (store.playing || store.mode === 'photo') return;
    const d = store.duration();
    if (d <= 0) return;
    this.sync.ensureAudio();
    if (store.t >= d - 1 / FPS) store.setTime(0, 'player');
    store.playing = true;
    this.restartClock();
    store.emit('play');
    const tick = () => {
      if (!store.playing) return;
      const t = this.t0 + (performance.now() - this.n0) / 1000;
      const dur = store.duration();
      if (t >= dur) { store.setTime(dur, 'player'); this.pause(); return; }
      store.t = t;
      store.emit('time', 'player');
      this.sync.sync(store.p, t, true);
      this.draw();
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }
  restartClock() { this.t0 = store.t; this.n0 = performance.now(); }
  pause() {
    if (!store.playing) return;
    store.playing = false;
    cancelAnimationFrame(this.raf);
    this.sync.pauseAll();
    this.syncNow();
    store.emit('play');
    this.requestRender();
  }
  toggle() { store.playing ? this.pause() : this.play(); }
}

export { findClip, mainSceneAt };
