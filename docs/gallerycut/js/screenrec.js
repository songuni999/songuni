// 화면 녹화: getDisplayMedia(화면 전체·창·탭) + 컴퓨터 소리·마이크(WebAudio로 섞기) → MediaRecorder
// 녹화 파일은 이 컴퓨터 안(IndexedDB)에만 저장된다. 외부 전송 없음.
import { store } from './store.js';
import { h, toast, stamp, download, fmtBytes, fmtDur } from './util.js';
import { icon } from './icons.js';
import { importFile, LIMITS } from './media.js';
import { fixWebmDuration } from './webmfix.js';

let ses = null; // 녹화 중인 세션
const OPT_KEY = 'nyangcut_rec_opts';
function loadOpts() {
  const d = { sys: true, mic: false, countdown: true };
  try { const v = JSON.parse(localStorage.getItem(OPT_KEY) || 'null'); if (v && typeof v === 'object') return { ...d, ...v }; } catch (e) { /* */ }
  return d;
}
function saveOpts(o) { try { localStorage.setItem(OPT_KEY, JSON.stringify(o)); } catch (e) { /* */ } }

export const isRecording = () => !!ses;
export function canRecordScreen() { return !!(navigator.mediaDevices?.getDisplayMedia && window.MediaRecorder); }

// MP4(H.264+AAC)를 먼저, 안 되면 WebM
const MIMES_MP4 = ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4;codecs=avc1', 'video/mp4'];
const MIMES_WEBM = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
function pickMime(prefer) {
  const list = prefer === 'webm' ? [...MIMES_WEBM, ...MIMES_MP4] : [...MIMES_MP4, ...MIMES_WEBM];
  for (const m of list) { try { if (MediaRecorder.isTypeSupported(m)) return m; } catch (e) { /* */ } }
  return '';
}
const fmtClock = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

// ── 녹화 전 설정 창 ──
export function openRecordDialog() {
  if (ses) { stopScreenRecord(); return; }
  if (!canRecordScreen()) { toast('이 브라우저는 화면 녹화를 지원하지 않아요. 크롬·웨일·엣지 최신판에서 써 주세요', { type: 'err', ms: 5000 }); return; }
  const o = loadOpts();
  const tg = (key, label, sub) => {
    const cb = h('input', { type: 'checkbox', checked: !!o[key], dataset: { opt: key } });
    cb.addEventListener('change', () => { o[key] = cb.checked; });
    return h('label', { class: 'toggle rec-opt' }, cb, h('span', { class: 'tg' }), h('span', null, h('b', null, label), h('small', { class: 'muted' }, sub)));
  };
  const close = () => dlg.remove();
  const go = () => { saveOpts(o); close(); startScreenRecord(o); };
  const dlg = h('div', { class: 'modal-back', onclick: (e) => { if (e.target === dlg) close(); } },
    h('div', { class: 'modal rec-modal', role: 'dialog', 'aria-label': '화면 녹화' },
      h('div', { class: 'modal-head' }, h('b', null, '화면 녹화'), h('button', { class: 'ibtn', onclick: close, 'aria-label': '닫기' }, icon('close'))),
      h('p', { class: 'note' }, '"녹화 시작"을 누르면 브라우저가 화면 전체 · 창 · 탭 중에서 고르는 창을 띄워요. 고르고 "공유"를 누르면 녹화가 시작돼요.'),
      h('div', { class: 'rec-opts' },
        tg('sys', '컴퓨터 소리 포함', '탭이나 화면 전체를 고를 때 "소리 공유"도 켜 주세요'),
        tg('mic', '마이크 같이 녹음', '내 목소리를 함께 넣어요 (둘 다 켜면 섞어서 녹음)'),
        tg('countdown', '3초 카운트다운', '시작 전에 3, 2, 1을 세요')),
      h('p', { class: 'note muted' }, '녹화 중에는 화면 위 작은 막대에서 일시정지·정지를 해요. 단축키 Ctrl+Shift+R로도 시작·정지할 수 있어요.'),
      h('div', { class: 'modal-foot' },
        h('button', { class: 'pbtn', onclick: close }, '취소'),
        h('button', { class: 'pbtn primary big', id: 'rec-start', onclick: go }, icon('record', 16), '녹화 시작'))));
  document.body.append(dlg);
}

// 단축키 Ctrl+Shift+R
export function toggleScreenRecord() {
  if (ses) { stopScreenRecord(); return; }
  if (!canRecordScreen()) { toast('이 브라우저는 화면 녹화를 지원하지 않아요', { type: 'err' }); return; }
  startScreenRecord(loadOpts());
}

export async function startScreenRecord(o) {
  if (ses) return null;
  let display;
  try {
    display = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30, max: 30 } },
      audio: !!o.sys,
      selfBrowserSurface: 'exclude', surfaceSwitching: 'include', monitorTypeSurfaces: 'include',
      systemAudio: o.sys ? 'include' : 'exclude',
    });
  } catch (e) {
    if (e && e.name === 'NotAllowedError') toast('화면 고르기를 취소했어요');
    else toast('화면을 가져오지 못했어요: ' + (e?.message || e), { type: 'err' });
    return null;
  }
  if (o.sys && !display.getAudioTracks().length) toast('고른 화면에서 소리를 받지 못했어요 (탭·화면 전체에서 "소리 공유"를 켜야 해요)', { ms: 5000 });
  let mic = null;
  if (o.mic) {
    try { mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
    catch (e) { toast('마이크를 쓸 수 없어 화면만 녹화해요. 주소창 옆에서 마이크를 허용해 주세요', { type: 'err', ms: 5000 }); }
  }
  return recordStreams(display, mic, o);
}

// 공용 녹화 장치(실제 화면 녹화와 시험용 가짜 스트림이 같은 길을 쓴다)
export async function recordStreams(display, mic, o = {}) {
  const vt = display.getVideoTracks()[0];
  if (!vt) { display.getTracks().forEach((t) => t.stop()); toast('녹화할 화면이 없어요', { type: 'err' }); return null; }
  const out = new MediaStream([vt]);
  const auds = [display, mic].filter((s) => s && s.getAudioTracks().length);
  let ac = null;
  if (auds.length === 1) out.addTrack(auds[0].getAudioTracks()[0]);
  else if (auds.length > 1) {
    // 컴퓨터 소리 + 마이크 → WebAudio로 섞어 소리 트랙 하나로
    ac = new AudioContext();
    const dest = ac.createMediaStreamDestination();
    for (const s of auds) {
      const src = ac.createMediaStreamSource(new MediaStream(s.getAudioTracks()));
      const g = ac.createGain(); g.gain.value = 1;
      src.connect(g); g.connect(dest);
    }
    out.addTrack(dest.stream.getAudioTracks()[0]);
  }
  const stopAll = () => {
    for (const s of [display, mic, out]) s?.getTracks().forEach((t) => { try { t.stop(); } catch (e) { /* */ } });
    try { ac?.close(); } catch (e) { /* */ }
  };
  const s = { o, display, mic, out, ac, stopAll, chunks: [], bytes: 0, ms: 0, paused: false, pausedTotal: 0, pausedAt: 0, t0: 0, bar: null, timer: 0, title: document.title };
  ses = s;
  // 브라우저의 "공유 중지"를 눌러도 정상 종료
  vt.addEventListener('ended', () => { if (ses === s) stopScreenRecord(); });
  if (o.countdown) {
    const ok = await countdown(s);
    if (!ok) { ses = null; stopAll(); toast('녹화를 취소했어요'); return null; }
  }
  if (ses !== s || vt.readyState === 'ended') { if (ses === s) ses = null; stopAll(); return null; }
  const mime = pickMime(o.prefer);
  let mr;
  try { mr = new MediaRecorder(out, mime ? { mimeType: mime, videoBitsPerSecond: 6e6, audioBitsPerSecond: 160e3 } : undefined); }
  catch (e) { ses = null; stopAll(); toast('녹화를 시작하지 못했어요: ' + e.message, { type: 'err' }); return null; }
  s.mr = mr; s.mime = mr.mimeType || mime || 'video/webm';
  mr.ondataavailable = (e) => {
    if (!e.data || !e.data.size) return;
    s.chunks.push(e.data); s.bytes += e.data.size;
    if (s.bytes > LIMITS.video * 0.97 && !s.stopping) { toast('파일이 2GB에 가까워 녹화를 멈췄어요', { ms: 5000 }); stopScreenRecord(); }
  };
  const finished = new Promise((res) => { mr.onstop = () => res(finish(s)); });
  s.finished = finished;
  mr.start(1000);
  s.t0 = performance.now();
  showBar(s);
  toast(`화면 녹화를 시작했어요 (${s.mime.includes('mp4') ? 'MP4' : 'WebM'})`);
  return finished;
}

function elapsed(s) {
  if (!s.t0) return 0;
  const now = performance.now();
  return now - s.t0 - s.pausedTotal - (s.paused ? now - s.pausedAt : 0);
}

function countdown(s) {
  return new Promise((res) => {
    let n = 3;
    const num = h('div', { class: 'cd-num' }, String(n));
    const ov = h('div', { class: 'cd-overlay', role: 'status' }, num, h('div', { class: 'cd-sub' }, '곧 녹화를 시작해요 · Esc로 취소'));
    document.body.append(ov);
    const end = (ok) => { clearInterval(id); window.removeEventListener('keydown', key, true); ov.remove(); res(ok); };
    const key = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); end(false); } };
    window.addEventListener('keydown', key, true);
    const id = setInterval(() => {
      if (ses !== s) { end(false); return; }
      n--;
      if (n <= 0) end(true); else num.textContent = String(n);
    }, 1000);
  });
}

function showBar(s) {
  const time = h('span', { class: 'rb-time' }, '00:00');
  const pauseBtn = h('button', { class: 'rb-btn', id: 'rb-pause', dataset: { tip: '일시정지 / 다시' }, onclick: () => togglePause() }, icon('pause', 16), h('span', null, '일시정지'));
  const stopBtn = h('button', { class: 'rb-btn stop', id: 'rb-stop', dataset: { tip: '녹화 끝내기', key: 'Ctrl+Shift+R' }, onclick: () => stopScreenRecord() }, icon('stop', 16), h('span', null, '정지'));
  const bar = h('div', { class: 'rec-bar', role: 'status', 'aria-label': '화면 녹화 중' }, h('span', { class: 'rb-dot' }), h('span', { class: 'rb-label' }, '녹화 중'), time, pauseBtn, stopBtn);
  document.body.append(bar);
  s.bar = bar; s.pauseBtn = pauseBtn; s.label = bar.querySelector('.rb-label');
  const tick = () => {
    const ms = elapsed(s);
    time.textContent = fmtClock(ms);
    document.title = (s.paused ? '[일시정지] ' : '● ') + fmtClock(ms) + ' · 갤러리컷 화면 녹화';
  };
  tick();
  s.timer = setInterval(tick, 250);
  document.getElementById('btn-screenrec')?.classList.add('recording');
}

export function togglePause() {
  const s = ses;
  if (!s || !s.mr || s.stopping) return;
  if (!s.paused) {
    try { s.mr.pause(); } catch (e) { return; }
    s.paused = true; s.pausedAt = performance.now();
    s.bar?.classList.add('paused');
    s.pauseBtn.replaceChildren(icon('play', 16), h('span', null, '다시'));
    s.label.textContent = '일시정지';
  } else {
    try { s.mr.resume(); } catch (e) { return; }
    s.paused = false; s.pausedTotal += performance.now() - s.pausedAt;
    s.bar?.classList.remove('paused');
    s.pauseBtn.replaceChildren(icon('pause', 16), h('span', null, '일시정지'));
    s.label.textContent = '녹화 중';
  }
}

export function stopScreenRecord() {
  const s = ses;
  if (!s || s.stopping) return s?.finished || null;
  s.stopping = true;
  if (!s.mr) { ses = null; s.stopAll(); return null; } // 카운트다운 중
  if (s.paused) { s.pausedTotal += performance.now() - s.pausedAt; s.paused = false; }
  s.ms = elapsed(s);
  try { if (s.mr.state !== 'inactive') s.mr.stop(); } catch (e) { /* */ }
  return s.finished;
}

async function finish(s) {
  clearInterval(s.timer);
  s.bar?.remove();
  document.title = s.title;
  document.getElementById('btn-screenrec')?.classList.remove('recording');
  s.stopAll();
  ses = null;
  if (!s.ms) s.ms = elapsed(s);
  const type = s.mime.split(';')[0] || 'video/webm';
  const ext = type.includes('mp4') ? 'mp4' : 'webm';
  let blob = new Blob(s.chunks, { type });
  if (blob.size < 1000) { toast('녹화된 내용이 없어요', { type: 'err' }); return null; }
  if (ext === 'webm') {
    try { blob = await fixWebmDuration(blob, s.ms); } catch (e) { console.warn('WebM 길이 보정 실패', e); }
  }
  const name = '화면녹화_' + stamp();
  const file = new File([blob], `${name}.${ext}`, { type });
  toast('녹화 파일을 정리하는 중…', { ms: 2000 });
  let m;
  try {
    m = await importFile(file, { name, duration: s.ms / 1000 }); // 형식·크기·앞 바이트 검사 포함
  } catch (e) {
    toast('녹화를 미디어에 넣지 못했어요: ' + e.message + ' — 파일로 저장은 할 수 있어요', { type: 'err', ms: 6000 });
    showResult(null, blob, name, ext, s.ms, s.o);
    return { media: null, blob, ms: s.ms, mime: s.mime };
  }
  store.emit('media');
  if (!s.o.noDialog) showResult(m, blob, name, ext, s.ms, s.o);
  toast('녹화가 끝났어요. 미디어 목록에 넣었어요');
  return { media: m, blob, ms: s.ms, mime: s.mime };
}

// ── 녹화 후 창 ──
function showResult(m, blob, name, ext, ms, o) {
  const url = m ? m.url : URL.createObjectURL(blob);
  const close = () => { if (!m) URL.revokeObjectURL(url); dlg.remove(); };
  const addBtn = h('button', { class: 'pbtn primary big', id: 'rec-add', disabled: !m, onclick: async () => {
    if (store.mode !== 'video') { const ph = await import('./photo.js'); ph.setMode('video'); }
    const a = await import('./actions.js');
    a.addMediaToTimeline(m);
    close();
  } }, icon('plus', 16), '타임라인에 넣기');
  const dlg = h('div', { class: 'modal-back', onclick: (e) => { if (e.target === dlg) close(); } },
    h('div', { class: 'modal rec-modal', role: 'dialog', 'aria-label': '화면 녹화 완료' },
      h('div', { class: 'modal-head' }, h('b', null, '화면 녹화 완료'), h('button', { class: 'ibtn', onclick: close, 'aria-label': '닫기' }, icon('close'))),
      h('video', { src: url, controls: true, playsinline: true, class: 'ex-video' }),
      h('div', { class: 'ex-info' }, `${name}.${ext} · ${fmtDur((m?.duration) || ms / 1000)} · ${fmtBytes(blob.size)} · ${ext.toUpperCase()}`),
      h('p', { class: 'note muted' }, m ? '왼쪽 미디어 목록에도 들어가 있어요(이 브라우저 안에 저장).' : '미디어 목록에는 넣지 못했어요.'),
      h('div', { class: 'modal-foot' },
        h('button', { class: 'pbtn', onclick: close }, '닫기'),
        h('button', { class: 'pbtn', id: 'rec-save', onclick: () => download(blob, `${name}.${ext}`) }, icon('save', 16), '파일로 저장'),
        addBtn)));
  document.body.append(dlg);
}

// 시험용: 가짜 스트림(canvas.captureStream 등)으로 같은 녹화 길을 돌린다
export async function testRecord(stream, ms = 3000, opt = {}) {
  const o = { sys: false, mic: false, countdown: !!opt.countdown, prefer: opt.prefer, noDialog: !!opt.noDialog };
  const p = recordStreams(stream, null, o);
  if (opt.pauseAt) {
    setTimeout(() => togglePause(), opt.pauseAt);
    setTimeout(() => togglePause(), opt.pauseAt + (opt.pauseMs || 1000));
  }
  const wait = ms + (opt.pauseAt ? (opt.pauseMs || 1000) : 0) + (opt.countdown ? 3000 : 0);
  setTimeout(() => { if (opt.endTrack) stream.getVideoTracks()[0]?.dispatchEvent(new Event('ended')); /* 브라우저 '공유 중지'와 같은 신호 */ else stopScreenRecord(); }, wait);
  const r = await p;
  if (!r) return null;
  return { id: r.media?.id, name: r.media?.name, duration: r.media?.duration, elapsedMs: Math.round(r.ms), mime: r.mime, size: r.blob.size, thumbs: r.media?.thumbs?.length || 0, hasAudio: !!r.media?.hasAudio, peaks: r.media?.peaks?.length || 0 };
}
