// 내보내기: Mediabunny(WebCodecs)로 프레임 단위 렌더 → MP4. 안 되면 MediaRecorder 실시간 녹화
import { store } from './store.js';
import { h, toast, fmtBytes, stamp, download, FPS } from './util.js';
import { icon } from './icons.js';
import { media, getAudioBuffer, seekEl } from './media.js';
import { canvasSize, projectDuration, videoClipsAt, srcTimeClamped, clipEnd, mediaDur, avClips } from './model.js';
import { renderFrame, imageSource } from './render.js';
import { ElementSync, fadeGain } from './player.js';
import { waitFonts } from './photo.js';
import { getPlayer } from './preview.js';

let MB = null;
async function loadMB() {
  if (MB) return MB;
  MB = await import('../vendor/mediabunny.min.mjs');
  return MB;
}

// 영상 프레임 공급자(내보내기용): 클립마다 순서대로 디코딩
class DecodeProvider {
  constructor(mb) { this.mb = mb; this.state = new Map(); this.inputs = new Map(); }
  async open(c, ts) {
    const m = media.get(c.mediaId);
    const mb = this.mb;
    try {
      if (!mb) throw new Error('no mb');
      let input = this.inputs.get(m.id);
      if (!input) { input = new mb.Input({ source: new mb.BlobSource(m.blob), formats: mb.ALL_FORMATS }); this.inputs.set(m.id, input); }
      const track = await input.getPrimaryVideoTrack();
      if (!track || !(await track.canDecode())) throw new Error('decode 불가');
      const sink = new mb.CanvasSink(track, { poolSize: 4 });
      const end = (c.in || 0) + (c.dur + 3) * (c.speed || 1);
      const iter = sink.canvases(Math.max(0, ts - 0.001), end);
      return { mode: 'mb', iter, cur: null, next: undefined, frame: null };
    } catch (e) {
      const el = document.createElement('video');
      el.muted = true; el.preload = 'auto'; el.src = m.url;
      document.getElementById('media-holder').append(el);
      return { mode: 'seek', el, frame: null };
    }
  }
  async advance(c, ts) {
    let s = this.state.get(c.id);
    if (!s) { s = await this.open(c, ts); this.state.set(c.id, s); }
    s.last = ts;
    if (s.mode === 'mb') {
      try {
        if (s.next === undefined) s.next = (await s.iter.next()).value || null;
        while (s.next && s.next.timestamp <= ts + 1e-4) {
          s.cur = s.next;
          s.next = (await s.iter.next()).value || null;
        }
        const w = s.cur || s.next;
        if (w) s.frame = { img: w.canvas, w: w.canvas.width, h: w.canvas.height };
      } catch (e) { console.warn('디코딩 오류', e); }
    } else {
      await seekEl(s.el, ts);
      if (s.el.videoWidth) s.frame = { img: s.el, w: s.el.videoWidth, h: s.el.videoHeight };
    }
  }
  async prepare(p, t) {
    const need = videoClipsAt(p, t);
    for (const c of need) {
      if (!media.get(c.mediaId)) continue;
      await this.advance(c, srcTimeClamped(c, t));
    }
    // 다 쓴 클립 정리
    for (const [id, s] of this.state) {
      if (need.some((c) => c.id === id)) continue;
      const c = findIn(p, id);
      if (!c || t > clipEnd(c) + 3) this.close(id, s);
    }
  }
  close(id, s) {
    try { if (s.mode === 'mb') s.iter.return?.(); else { s.el.removeAttribute('src'); s.el.load(); s.el.remove(); } } catch (e) { /* */ }
    this.state.delete(id);
  }
  get(clip) {
    if (clip.type === 'image') return imageSource(clip);
    return this.state.get(clip.id)?.frame || null;
  }
  dispose() { for (const [id, s] of this.state) this.close(id, s); this.inputs.clear(); }
}
function findIn(p, id) { for (const tr of p.tracks) for (const c of tr.clips) if (c.id === id) return c; return null; }

// 소리 섞기(OfflineAudioContext)
export async function mixAudio(p, dur, sr = 48000) {
  const len = Math.max(1, Math.ceil(dur * sr));
  const ctx = new OfflineAudioContext(2, len, sr);
  for (const tr of p.tracks) {
    if (tr.muted) continue;
    if (tr.kind === 'text') continue;
    for (const c of avClips(tr)) {
      if (c.disabled || c.muted) continue;
      if (tr.hidden && c.type === 'video') continue;
      const m = media.get(c.mediaId);
      if (!m || !m.hasAudio) continue;
      const buf = await getAudioBuffer(c.mediaId);
      if (!buf) continue;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = c.speed || 1;
      const g = ctx.createGain();
      const vol = c.volume ?? 1;
      const a = c.start, b = clipEnd(c);
      g.gain.setValueAtTime(c.fadeIn > 0 ? 0 : vol, a);
      if (c.fadeIn > 0) g.gain.linearRampToValueAtTime(vol, a + c.fadeIn);
      if (c.fadeOut > 0) { g.gain.setValueAtTime(vol, Math.max(a, b - c.fadeOut)); g.gain.linearRampToValueAtTime(0, b); }
      src.connect(g); g.connect(ctx.destination);
      const off = Math.max(0, c.in || 0);
      const srcLen = Math.min(c.dur * (c.speed || 1), Math.max(0, buf.duration - off));
      if (srcLen <= 0) continue;
      src.start(a, off, srcLen);
    }
  }
  return await ctx.startRendering();
}

function outSize(p, res) {
  const { W, H } = canvasSize(p);
  const k = res / Math.min(W, H);
  const even = (v) => Math.max(2, Math.round(v / 2) * 2);
  return { W, H, pw: even(W * k), ph: even(H * k), k: even(W * k) / W };
}

// 내보내기 본체: Blob 반환. onProgress(0~1)
export async function exportVideo({ res = 1080, onProgress = () => {}, signal = { cancel: false }, forceFallback = false, audioCtx = null } = {}) {
  const p = structuredClone(store.video);
  const dur = projectDuration(p);
  if (dur <= 0) throw new Error('타임라인이 비어 있어요');
  await waitFonts(p);
  const sz = outSize(p, res);
  let mb = null;
  try { mb = await loadMB(); } catch (e) { console.warn('Mediabunny 불러오기 실패', e); }
  const hasWC = typeof VideoEncoder !== 'undefined' && typeof AudioEncoder !== 'undefined';
  let canAvc = false, audioCodec = null;
  if (mb && hasWC && !forceFallback) {
    try { canAvc = await mb.canEncodeVideo('avc', { width: sz.pw, height: sz.ph }); } catch (e) { canAvc = false; }
    try { if (await mb.canEncodeAudio('aac')) audioCodec = 'aac'; else if (await mb.canEncodeAudio('opus')) audioCodec = 'opus'; } catch (e) { audioCodec = null; }
  }
  if (canAvc) {
    try { const out = await exportWithMB(mb, p, dur, sz, audioCodec, onProgress, signal); try { audioCtx?.close(); } catch (e) { /* */ } return out; }
    catch (e) {
      if (signal.cancel) { try { audioCtx?.close(); } catch (er) { /* */ } throw e; }
      console.warn('빠른 내보내기 실패 → 실시간 녹화로', e);
    }
  }
  return await exportRealtime(p, dur, sz, onProgress, signal, audioCtx);
}

async function exportWithMB(mb, p, dur, sz, audioCodec, onProgress, signal) {
  const canvas = document.createElement('canvas');
  canvas.width = sz.pw; canvas.height = sz.ph;
  const ctx = canvas.getContext('2d');
  const output = new mb.Output({ format: new mb.Mp4OutputFormat({ fastStart: 'in-memory' }), target: new mb.BufferTarget() });
  const vsrc = new mb.CanvasSource(canvas, { codec: 'avc', quality: mb.QUALITY_HIGH, keyFrameInterval: 2 });
  output.addVideoTrack(vsrc, { frameRate: FPS });
  let asrc = null;
  if (audioCodec) { asrc = new mb.AudioBufferSource({ codec: audioCodec, bitrate: 160e3 }); output.addAudioTrack(asrc); }
  await output.start();
  const prov = new DecodeProvider(mb);
  const total = Math.max(1, Math.round(dur * FPS));
  try {
    if (asrc) {
      onProgress(0, '소리 섞는 중…');
      const ab = await mixAudio(p, total / FPS);
      if (signal.cancel) throw new Error('취소');
      await asrc.add(ab);
      asrc.close();
    }
    for (let i = 0; i < total; i++) {
      if (signal.cancel) throw new Error('취소');
      const t = i / FPS;
      await prov.prepare(p, t);
      renderFrame(ctx, p, t, prov, { W: sz.W, H: sz.H, k: sz.k, pw: sz.pw, ph: sz.ph });
      await vsrc.add(t, 1 / FPS);
      if (i % 3 === 0) onProgress((i + 1) / total, `화면 만드는 중… ${i + 1}/${total}프레임`);
    }
    vsrc.close();
    onProgress(1, '마무리 중…');
    await output.finalize();
  } catch (e) {
    try { await output.cancel(); } catch (er) { /* */ }
    prov.dispose();
    throw e;
  }
  prov.dispose();
  return { blob: new Blob([output.target.buffer], { type: 'video/mp4' }), ext: 'mp4', method: 'webcodecs' };
}

// 이 기기에서 쓸 내보내기 방식(WebCodecs가 없으면 MediaRecorder 실시간 녹화)
export function exportMethodInfo() {
  const wc = typeof VideoEncoder !== 'undefined' && typeof AudioEncoder !== 'undefined';
  const mr = !!(window.MediaRecorder && HTMLCanvasElement.prototype.captureStream);
  return { wc, mr };
}

async function exportRealtime(p, dur, sz, onProgress, signal, audioCtx = null) {
  if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) throw new Error('이 브라우저는 내보내기를 지원하지 않아요');
  const canvas = document.createElement('canvas');
  canvas.width = sz.pw; canvas.height = sz.ph;
  const ctx = canvas.getContext('2d');
  const holder = document.getElementById('media-holder');
  const sync = new ElementSync(holder, { audio: false });
  onProgress(0, '소리 섞는 중…');
  const ab = await mixAudio(p, dur);
  // 폰(특히 아이폰)은 버튼을 누른 순간 만든 AudioContext만 소리를 낸다 → 받은 게 있으면 그것을 쓴다
  const ac = audioCtx && audioCtx.state !== 'closed' ? audioCtx : new (window.AudioContext || window.webkitAudioContext)();
  const dest = ac.createMediaStreamDestination();
  const bs = ac.createBufferSource(); bs.buffer = ab; bs.connect(dest);
  const stream = canvas.captureStream(FPS);
  for (const tr of dest.stream.getAudioTracks()) stream.addTrack(tr);
  const mime = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find((t) => MediaRecorder.isTypeSupported(t)) || '';
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8e6 });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const done = new Promise((res) => { rec.onstop = res; });
  // 첫 화면 준비
  sync.sync(p, 0, false);
  await new Promise((r) => setTimeout(r, 400));
  rec.start(500);
  await Promise.race([ac.resume().catch(() => {}), new Promise((r) => setTimeout(r, 1500))]);
  const n0 = performance.now();
  bs.start();
  await new Promise((resolve) => {
    const step = () => {
      const t = (performance.now() - n0) / 1000;
      if (signal.cancel || t >= dur) { resolve(); return; }
      sync.sync(p, t, true);
      renderFrame(ctx, p, t, sync, { W: sz.W, H: sz.H, k: sz.k, pw: sz.pw, ph: sz.ph });
      onProgress(t / dur, '실시간 녹화 중… (이 방식은 영상 길이만큼 걸려요)');
      setTimeout(step, 1000 / FPS / 2);
    };
    step();
  });
  rec.stop();
  await done;
  try { bs.stop(); } catch (e) { /* */ }
  ac.close();
  sync.pauseAll();
  for (const id of [...sync.els.keys()]) sync.drop(id);
  if (signal.cancel) throw new Error('취소');
  const type = (mime || 'video/webm').split(';')[0];
  return { blob: new Blob(chunks, { type }), ext: type.includes('mp4') ? 'mp4' : 'webm', method: 'mediarecorder' };
}

// ── 내보내기 창 ──
export function openExportDialog() {
  if (store.mode === 'photo') { import('./photo.js').then((m) => m.savePhoto('png')); return; }
  if (store.duration() <= 0) { toast('먼저 사진이나 영상을 타임라인에 넣어 주세요'); return; }
  getPlayer()?.pause();
  const mob = document.body.classList.contains('m');
  let res = mob ? 720 : (store.video.exportRes || 1080); // 폰은 메모리를 생각해 720p가 기본
  const signal = { cancel: false };
  let running = false, resultUrl = null;
  const { W, H } = canvasSize(store.video);
  const resSeg = h('div', { class: 'seg' });
  let drawRes = () => resSeg.replaceChildren(...[720, 1080].map((r) => {
    const s = outSize(store.video, r);
    return h('button', { class: 'seg-btn' + (res === r ? ' on' : ''), onclick: () => { res = r; drawRes(); } }, `${r}p (${s.pw}×${s.ph})`);
  }));
  const resNote = h('div', { class: 'warn-note hidden', id: 'ex-res-note' }, '1080p는 폰에서는 느릴 수 있어요. 메모리가 모자라면 중간에 멈출 수 있으니 길면 720p를 권해요.');
  const drawRes0 = drawRes;
  drawRes = () => { drawRes0(); resNote.classList.toggle('hidden', !(mob && res === 1080)); };
  drawRes();
  const bar = h('div', { class: 'pbar-fill' });
  const status = h('div', { class: 'ex-status' }, '');
  const eta = h('div', { class: 'ex-eta muted' }, '');
  const prog = h('div', { class: 'ex-progress hidden' }, h('div', { class: 'pbar-track' }, bar), status, eta);
  const result = h('div', { class: 'ex-result hidden' });
  const startBtn = h('button', { class: 'pbtn primary big', id: 'ex-start' }, icon('export', 18), '내보내기 시작');
  const cancelBtn = h('button', { class: 'pbtn', id: 'ex-cancel' }, '닫기');
  const opts = h('div', { class: 'ex-opts' },
    h('div', { class: 'prow' }, h('label', { class: 'plabel' }, '해상도'), resSeg),
    h('div', { class: 'prow' }, h('label', { class: 'plabel' }, '프레임'), h('span', null, '30fps')),
    h('div', { class: 'prow' }, h('label', { class: 'plabel' }, '형식'), h('span', null, 'MP4 (H.264 + AAC)')),
    h('div', { class: 'prow' }, h('label', { class: 'plabel' }, '길이'), h('span', null, `${(store.duration()).toFixed(1)}초 · 화면비 ${store.video.aspect} (${W}×${H} 기준)`)),
    mob ? resNote : null, mob ? phoneNotes() : null);
  const close = () => {
    if (running) { signal.cancel = true; return; }
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    dlg.remove();
  };
  const dlg = h('div', { class: 'modal-back' },
    h('div', { class: 'modal ex-modal', role: 'dialog', 'aria-label': '내보내기' },
      h('div', { class: 'modal-head' }, h('b', null, '영상 내보내기'), h('button', { class: 'ibtn', onclick: close, 'aria-label': '닫기' }, icon('close'))),
      opts, prog, result,
      h('div', { class: 'modal-foot' }, cancelBtn, startBtn)));
  cancelBtn.addEventListener('click', close);
  startBtn.addEventListener('click', async () => {
    if (running) return;
    running = true;
    // 폰: 버튼을 누른 이 순간에 소리 장치를 열어 둔다(아이폰은 이렇게 해야 실시간 녹화에 소리가 들어감)
    let audioCtx = null;
    if (mob) { try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); audioCtx.resume().catch(() => {}); } catch (e) { audioCtx = null; } }
    opts.classList.add('hidden'); startBtn.classList.add('hidden'); result.classList.add('hidden');
    prog.classList.remove('hidden');
    cancelBtn.textContent = '취소';
    const t0 = performance.now();
    try {
      const out = await exportVideo({
        res, signal, audioCtx,
        onProgress: (f, msg) => {
          bar.style.width = (f * 100).toFixed(1) + '%';
          if (msg) status.textContent = msg + ` (${Math.round(f * 100)}%)`;
          const el = (performance.now() - t0) / 1000;
          if (f > 0.03 && f < 1) eta.textContent = `남은 시간 약 ${Math.max(1, Math.round(el / f - el))}초`;
          else eta.textContent = '';
        },
      });
      running = false;
      lastExport = out;
      const name = `갤러리컷_${stamp()}.${out.ext}`;
      resultUrl = URL.createObjectURL(out.blob);
      prog.classList.add('hidden');
      result.classList.remove('hidden');
      result.replaceChildren(...[
        h('video', { src: resultUrl, controls: true, class: 'ex-video', playsinline: true }),
        h('div', { class: 'ex-info' }, `${name} · ${fmtBytes(out.blob.size)} · ${((performance.now() - t0) / 1000).toFixed(1)}초 걸림${out.method === 'mediarecorder' ? ' · 실시간 녹화 방식' : ''}`),
        out.ext !== 'mp4' ? h('div', { class: 'warn-note' }, '이 브라우저에서는 MP4를 못 만들어 WebM으로 저장해요. 크롬·웨일 최신판을 쓰면 MP4로 나와요.') : null,
        mob ? shareButton(out, name) : null,
        mob ? h('p', { class: 'note' }, '아이폰: "갤러리에 저장/공유" → "동영상 저장"을 누르면 사진 앱에 들어가요. 안드로이드는 갤러리·파일 앱을 고르세요.') : null,
        h('button', { class: 'pbtn' + (mob ? '' : ' primary') + ' big', id: 'ex-save', onclick: () => download(out.blob, name) }, icon('save', 18), mob ? '파일로 저장' : '저장하기')].filter(Boolean));
      cancelBtn.textContent = '닫기';
      toast('내보내기가 끝났어요! "저장하기"를 누르세요');
    } catch (e) {
      running = false;
      prog.classList.add('hidden'); opts.classList.remove('hidden'); startBtn.classList.remove('hidden');
      cancelBtn.textContent = '닫기';
      if (signal.cancel) { toast('내보내기를 취소했어요'); signal.cancel = false; }
      else { console.error(e); toast('내보내기에 실패했어요: ' + (e.message || e), { type: 'err', ms: 6000 }); }
    }
  });
  document.body.append(dlg);
}
export let lastExport = null;

// 폰: 갤러리에 저장/공유 버튼(navigator.share 로 파일 넘기기). 못 쓰면 버튼을 안 띄운다
function shareButton(out, name) {
  const type = out.ext === 'mp4' ? 'video/mp4' : 'video/webm';
  let file;
  try { file = new File([out.blob], name, { type }); } catch (e) { return null; }
  let ok = false;
  try { ok = !!(navigator.share && navigator.canShare && navigator.canShare({ files: [file] })); } catch (e) { ok = false; }
  if (!ok) return null;
  return h('button', { class: 'pbtn primary big', id: 'ex-share', onclick: async () => {
    try { await navigator.share({ files: [file], title: '갤러리컷' }); }
    catch (e) { if (e && e.name === 'AbortError') return; download(out.blob, name); toast('공유가 안 돼서 파일로 저장했어요'); }
  } }, icon('save', 18), '갤러리에 저장/공유');
}

// 폰 안내: 내보내기 방식, 긴 영상 메모리 경고
function phoneNotes() {
  const out = [];
  const { wc, mr } = exportMethodInfo();
  out.push(h('div', { class: 'prow' }, h('label', { class: 'plabel' }, '방식'),
    h('span', { id: 'ex-method' }, wc ? '빠른 방식 (WebCodecs)' : mr ? '실시간 녹화 방식 (영상 길이만큼 걸려요, 화면을 끄지 마세요)' : '이 브라우저는 내보내기를 지원하지 않아요')));
  // 소리를 통째로 풀어서 섞기 때문에, 길거나 큰 영상은 폰 메모리가 모자랄 수 있다
  let audioSec = 0, bigFile = 0;
  const seen = new Set();
  for (const tr of store.video.tracks) for (const c of avClips(tr)) {
    const m = media.get(c.mediaId);
    if (!m || seen.has(m.id)) continue;
    seen.add(m.id);
    if (m.hasAudio || m.kind === 'video') audioSec += m.duration || 0;
    bigFile = Math.max(bigFile, m.size || 0);
  }
  const dur = store.duration();
  if (dur > 180 || audioSec > 600 || bigFile > 400 * 1024 * 1024) {
    out.push(h('div', { class: 'warn-note', id: 'ex-long-note' }, `영상이 길거나 파일이 커서(전체 ${Math.round(dur)}초, 원본 소리 약 ${Math.round(audioSec / 60)}분) 폰 메모리가 모자랄 수 있어요. 중간에 멈추면 720p로 하거나, 영상을 나눠서 내보내 주세요.`));
  }
  return out;
}
export { mediaDur, seekEl };
