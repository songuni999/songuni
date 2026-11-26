// 미디어 가져오기·검증·썸네일·파형
import { db } from './db.js';
import { uid, cleanText, fmtBytes } from './util.js';

export const media = new Map(); // id → 기록(+실행 중 url/bitmap/thumbImgs)
const audioBuffers = new Map();

const MB = 1024 * 1024;
export const LIMITS = { image: 50 * MB, video: 2048 * MB, audio: 200 * MB };
const EXT = {
  jpg: 'image', jpeg: 'image', png: 'image', webp: 'image', gif: 'image',
  mp4: 'video', webm: 'video', mov: 'video',
  mp3: 'audio', wav: 'audio', m4a: 'audio', aac: 'audio', ogg: 'audio',
};
export const ACCEPT = '.jpg,.jpeg,.png,.webp,.gif,.mp4,.webm,.mov,.mp3,.wav,.m4a,.aac,.ogg,image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/quicktime,audio/mpeg,audio/wav,audio/mp4,audio/aac,audio/ogg';
export const ACCEPT_IMAGE = '.jpg,.jpeg,.png,.webp,.gif,image/jpeg,image/png,image/webp,image/gif';

// 파일 앞 바이트(매직 넘버)로 실제 내용 확인
async function sniffOk(file, ext) {
  const b = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  if (b.length < 4) return false;
  const s = (o, n) => String.fromCharCode(...b.slice(o, o + n));
  switch (ext) {
    case 'jpg': case 'jpeg': return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    case 'png': return b[0] === 0x89 && s(1, 3) === 'PNG';
    case 'gif': return s(0, 4) === 'GIF8';
    case 'webp': return s(0, 4) === 'RIFF' && s(8, 4) === 'WEBP';
    case 'mp4': case 'mov': case 'm4a':
      return ['ftyp', 'moov', 'mdat', 'free', 'wide', 'skip', 'pnot'].includes(s(4, 4));
    case 'webm': return b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3;
    case 'mp3': return s(0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0);
    case 'wav': return s(0, 4) === 'RIFF' && s(8, 4) === 'WAVE';
    case 'aac': return (b[0] === 0xff && (b[1] & 0xf6) === 0xf0) || s(0, 4) === 'ADIF' || s(0, 3) === 'ID3';
    case 'ogg': return s(0, 4) === 'OggS';
    default: return false;
  }
}

export async function validateFile(file) {
  const name = file.name || '';
  const ext = (name.split('.').pop() || '').toLowerCase();
  const kind = EXT[ext];
  if (!kind) return { ok: false, reason: `지원하지 않는 형식이에요 (${ext || '확장자 없음'})` };
  if (file.size <= 0) return { ok: false, reason: '빈 파일이에요' };
  if (file.size > LIMITS[kind]) return { ok: false, reason: `파일이 너무 커요 (${fmtBytes(file.size)}, 최대 ${fmtBytes(LIMITS[kind])})` };
  let ok = false;
  try { ok = await sniffOk(file, ext); } catch (e) { ok = false; }
  if (!ok) return { ok: false, reason: '파일 내용이 확장자와 달라요' };
  return { ok: true, kind, ext };
}

function waitEvent(el, ev, ms = 15000) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => { cleanup(); rej(new Error('timeout ' + ev)); }, ms);
    const ok = () => { cleanup(); res(); };
    const bad = () => { cleanup(); rej(new Error('media error')); };
    function cleanup() { clearTimeout(t); el.removeEventListener(ev, ok); el.removeEventListener('error', bad); }
    el.addEventListener(ev, ok, { once: true });
    el.addEventListener('error', bad, { once: true });
  });
}
export async function seekEl(el, t) {
  if (Math.abs(el.currentTime - t) < 0.001 && el.readyState >= 2) return;
  const p = waitEvent(el, 'seeked', 8000);
  el.currentTime = t;
  try { await p; } catch (e) { /* 넘어간다 */ }
}

async function canvasToBlob(c, type = 'image/jpeg', q = 0.75) {
  return new Promise((res) => c.toBlob((b) => res(b), type, q));
}

let decodeCtx = null;
async function decodeAudio(blob) {
  const buf = await blob.arrayBuffer();
  decodeCtx ||= new OfflineAudioContext(2, 48000, 48000);
  return await decodeCtx.decodeAudioData(buf);
}
const PEAK_RATE = 50;
function computePeaks(ab) {
  const n = Math.max(1, Math.ceil(ab.duration * PEAK_RATE));
  const out = new Float32Array(n);
  const chs = [];
  for (let c = 0; c < ab.numberOfChannels; c++) chs.push(ab.getChannelData(c));
  const per = ab.length / n;
  for (let i = 0; i < n; i++) {
    let mx = 0;
    const a = Math.floor(i * per), b = Math.min(ab.length, Math.floor((i + 1) * per));
    const step = Math.max(1, Math.floor((b - a) / 200));
    for (const d of chs) for (let j = a; j < b; j += step) { const v = Math.abs(d[j]); if (v > mx) mx = v; }
    out[i] = mx;
  }
  return out;
}

// 녹화한 webm은 길이가 Infinity로 나올 때가 있다 → 맨 끝으로 한 번 이동해 실제 길이를 알아낸다
async function settleDuration(el, known) {
  if (isFinite(el.duration) && el.duration > 0) return el.duration;
  try {
    const p = new Promise((res) => {
      const done = () => { if (isFinite(el.duration)) { el.removeEventListener('durationchange', done); el.removeEventListener('timeupdate', done); res(); } };
      el.addEventListener('durationchange', done); el.addEventListener('timeupdate', done);
      setTimeout(res, 6000);
    });
    el.currentTime = 1e101;
    await p;
    el.currentTime = 0;
    await new Promise((r) => setTimeout(r, 50));
  } catch (e) { /* */ }
  if (isFinite(el.duration) && el.duration > 0) return el.duration;
  return known || 0;
}

async function analyze(file, kind, known = 0) {
  const rec = { kind, duration: 0, width: 0, height: 0, hasAudio: false, thumbs: [], peaks: null, peakRate: PEAK_RATE };
  if (kind === 'image') {
    const bmp = await createImageBitmap(file);
    rec.width = bmp.width; rec.height = bmp.height; rec.duration = 3;
    const th = 160, tw = Math.max(1, Math.round(th * bmp.width / bmp.height));
    const c = document.createElement('canvas'); c.width = Math.min(tw, 400); c.height = th;
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    rec.thumbs = [await canvasToBlob(c)];
    bmp.close?.();
    return rec;
  }
  const url = URL.createObjectURL(file);
  try {
    const el = document.createElement(kind === 'audio' ? 'audio' : 'video');
    el.preload = 'auto'; el.muted = true; el.playsInline = true;
    const ready = waitEvent(el, 'loadedmetadata');
    el.src = url;
    await ready;
    rec.duration = await settleDuration(el, known);
    if (kind === 'video') {
      rec.width = el.videoWidth; rec.height = el.videoHeight;
      if (!rec.width) { rec.kind = kind = 'audio'; }
    }
    if (kind === 'video') {
      try { if (el.readyState < 2) await waitEvent(el, 'loadeddata', 8000); } catch (e) { /* */ }
      const n = Math.max(1, Math.min(40, Math.ceil(rec.duration / 1)));
      const th = 72, tw = Math.max(1, Math.round(th * rec.width / rec.height));
      const c = document.createElement('canvas'); c.width = tw; c.height = th;
      const x = c.getContext('2d');
      for (let i = 0; i < n; i++) {
        const t = Math.min(rec.duration - 0.05, (i + 0.5) * rec.duration / n);
        await seekEl(el, Math.max(0, t));
        x.drawImage(el, 0, 0, tw, th);
        rec.thumbs.push(await canvasToBlob(c));
      }
    }
    el.removeAttribute('src'); el.load();
  } finally {
    URL.revokeObjectURL(url);
  }
  // 소리(파형). 아주 큰 파일은 메모리 때문에 건너뛴다.
  if (file.size < 400 * MB) {
    try {
      const ab = await decodeAudio(file);
      rec.hasAudio = ab.length > 0;
      rec.peaks = computePeaks(ab);
      if (!rec.duration) rec.duration = ab.duration;
    } catch (e) { rec.hasAudio = false; }
  } else rec.hasAudio = kind === 'audio';
  if (kind === 'audio' && !rec.duration) throw new Error('길이를 알 수 없는 오디오');
  return rec;
}

async function hydrate(rec) {
  rec.url = URL.createObjectURL(rec.blob);
  if (rec.kind === 'image') {
    try { rec.bitmap = await createImageBitmap(rec.blob); } catch (e) { rec.bitmap = null; }
  }
  rec.thumbImgs = [];
  for (const b of rec.thumbs || []) {
    try { rec.thumbImgs.push(await createImageBitmap(b)); } catch (e) { /* */ }
  }
  rec.thumbUrl = rec.thumbs && rec.thumbs[0] ? URL.createObjectURL(rec.thumbs[0]) : '';
  media.set(rec.id, rec);
  return rec;
}

// 파일 하나 가져오기 → 기록 반환(실패 시 throw)
export async function importFile(file, opt = {}) {
  let kind = opt.kind;
  if (!opt.trusted) {
    const v = await validateFile(file);
    if (!v.ok) throw new Error(v.reason);
    kind = v.kind;
  }
  const info = await analyze(file, kind, opt.duration || 0);
  const rec = {
    id: uid('m'), // 내부 이름은 새 ID
    name: cleanText(opt.name || file.name || '파일', 80),
    mime: file.type || '',
    size: file.size,
    created: Date.now(),
    ...info,
    blob: file,
  };
  const { url, bitmap, thumbImgs, thumbUrl, ...plain } = rec;
  const saved = await db.put('media', plain);
  if (!saved) console.warn('미디어 저장 실패(용량?)');
  return hydrate(rec);
}

export async function loadAllMedia() {
  const list = await db.all('media');
  list.sort((a, b) => (a.created || 0) - (b.created || 0));
  for (const rec of list) {
    try { await hydrate(rec); } catch (e) { console.warn('미디어 복원 실패', e); }
  }
}

export async function removeMedia(id) {
  const m = media.get(id);
  if (!m) return;
  try { URL.revokeObjectURL(m.url); if (m.thumbUrl) URL.revokeObjectURL(m.thumbUrl); } catch (e) { /* */ }
  media.delete(id);
  audioBuffers.delete(id);
  await db.del('media', id);
}

export async function getAudioBuffer(id) {
  if (audioBuffers.has(id)) return audioBuffers.get(id);
  const m = media.get(id);
  if (!m || !m.blob) return null;
  const p = decodeAudio(m.blob).catch(() => null);
  audioBuffers.set(id, p);
  return p;
}

export function thumbAt(m, srcT) {
  if (!m) return null;
  if (m.kind === 'image') return m.bitmap || m.thumbImgs?.[0] || null;
  const arr = m.thumbImgs || [];
  if (!arr.length) return null;
  const i = Math.max(0, Math.min(arr.length - 1, Math.floor(srcT / (m.duration || 1) * arr.length)));
  return arr[i];
}
