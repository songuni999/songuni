// 편집 동작 모음(버튼·단축키·패널이 같이 쓴다)
import { store } from './store.js';
import { toast, uid, FPS } from './util.js';
import { media, importFile } from './media.js';
import {
  findClip, splitClip, removeClip, trimAt, clipEnd, mainTrack, packMain, placeClip, addToMain,
  makeMediaClip, makeAudioClip, makeTextClip, makeStickerClip, mainBoundaries, fixOverlap, trackFree, sortTrack,
  makeCollageClip,
} from './model.js';
import { LAYOUT_MAP, cellCount, newCell } from './collage.js';
import { TRANS_NAME, FILTER_MAP } from './effects.js';

function sel() { return store.selected(); }
function locked(f) { if (f && f.track.locked) { toast('잠긴 트랙이에요. 자물쇠를 풀어 주세요'); return true; } return false; }
function needVideo() { if (store.mode === 'photo') { toast('사진 편집에서는 쓸 수 없어요'); return true; } return false; }

// 선택이 없으면 재생헤드 아래 메인 클립을 대상으로
function targetClip() {
  const f = sel();
  if (f) return f;
  const tr = mainTrack(store.p);
  const c = tr.clips.find((x) => store.t > x.start && store.t < clipEnd(x));
  return c ? findClip(store.p, c.id) : null;
}

export function split() {
  if (needVideo()) return;
  const f = targetClip();
  if (!f) { toast('자를 클립을 고르거나 재생헤드를 클립 위에 두세요'); return; }
  if (locked(f)) return;
  const b = splitClip(store.p, f.clip.id, store.t);
  if (!b) { toast('재생헤드가 클립 안쪽에 있어야 자를 수 있어요'); return; }
  store.commit('분할했어요', { undoHint: true });
}
export function splitAll() {
  if (needVideo()) return;
  let n = 0;
  for (const tr of store.p.tracks) {
    if (tr.locked) continue;
    for (const c of [...tr.clips]) if (splitClip(store.p, c.id, store.t)) n++;
  }
  if (!n) { toast('재생헤드 위치에 자를 클립이 없어요'); return; }
  store.commit(`클립 ${n}개를 모두 분할했어요`, { undoHint: true });
}
export function del() {
  if (store.selTrans) { removeTransition(store.selTrans); return; }
  const f = sel();
  if (!f) { toast('지울 클립을 먼저 눌러 고르세요'); return; }
  if (locked(f)) return;
  if (store.mode === 'photo' && f.track.kind === 'main') { toast('사진은 지울 수 없어요. 새 사진 열기를 쓰세요'); return; }
  removeClip(store.p, f.clip.id);
  store.select(null);
  store.commit('삭제했어요', { undoHint: true });
}
export function trimSide(side) {
  if (needVideo()) return;
  const f = targetClip();
  if (!f) { toast('클립을 고르고 재생헤드를 그 안에 두세요'); return; }
  if (locked(f)) return;
  if (!trimAt(store.p, f.clip.id, store.t, side)) { toast('재생헤드가 클립 안쪽에 있어야 해요'); return; }
  if (side === 'left' && f.track.kind === 'main' && store.p.magnet) store.setTime(f.clip.start);
  store.commit(side === 'left' ? '재생헤드 왼쪽을 지웠어요' : '재생헤드 오른쪽을 지웠어요', { undoHint: true });
}
export function duplicate() {
  if (needVideo()) return;
  const f = sel();
  if (!f) { toast('복제할 클립을 고르세요'); return; }
  if (locked(f)) return;
  const c = structuredClone(f.clip);
  c.id = uid('c');
  if (f.track.kind === 'main') {
    f.track.clips.splice(f.index + 1, 0, c);
    if (store.p.magnet) { f.track.clips.forEach((x, i) => { x.start = i; }); packMain(store.p); }
    else { c.start = clipEnd(f.clip); fixOverlap(store.p, c); }
  } else {
    c.start = clipEnd(f.clip);
    if (!trackFree(f.track, c.start, c.dur)) placeClip(store.p, c, f.track);
    else { f.track.clips.push(c); sortTrack(f.track); }
  }
  store.select(c.id);
  store.commit('복제했어요');
}
export function copy() {
  const f = sel();
  if (!f) { toast('복사할 클립을 고르세요'); return; }
  store.clipboard = { clip: structuredClone(f.clip), kind: f.track.kind };
  toast('복사했어요 (Ctrl+V로 붙여넣기)');
}
export function paste() {
  if (needVideo()) return;
  const cb = store.clipboard;
  if (!cb) { toast('먼저 Ctrl+C로 클립을 복사하세요'); return; }
  const c = structuredClone(cb.clip);
  c.id = uid('c');
  c.start = store.t;
  if (c.mediaId && !media.has(c.mediaId)) { toast('원본 파일이 없어 붙여넣을 수 없어요'); return; }
  if (cb.kind === 'main') addToMain(store.p, c, store.t);
  else placeClip(store.p, c, null);
  store.select(c.id);
  store.commit('붙여넣었어요');
}
export function toggleClip() {
  const f = sel();
  if (!f) { toast('켜고 끌 클립을 고르세요'); return; }
  if (locked(f)) return;
  f.clip.disabled = !f.clip.disabled;
  store.commit(f.clip.disabled ? '클립을 껐어요(안 보이고 안 들려요)' : '클립을 켰어요');
}
export function toggleMagnet() {
  const p = store.p;
  p.magnet = !p.magnet;
  if (p.magnet) packMain(p);
  store.commit(p.magnet ? '메인 트랙 자석 켬: 틈이 자동으로 메워져요' : '메인 트랙 자석 끔: 자유롭게 놓을 수 있어요');
  store.emit('flags');
}
export function toggleSnap() {
  store.p.snap = !store.p.snap;
  store.commit(store.p.snap ? '자동 스냅 켰어요' : '자동 스냅 껐어요');
  store.emit('flags');
}
export function trackFlag(id, key) {
  const tr = store.p.tracks.find((t) => t.id === id);
  if (!tr) return;
  tr[key] = !tr[key];
  const msg = { hidden: tr.hidden ? '트랙을 숨겼어요' : '트랙을 보이게 했어요', locked: tr.locked ? '트랙을 잠갔어요' : '트랙 잠금을 풀었어요', muted: tr.muted ? '트랙 소리를 껐어요' : '트랙 소리를 켰어요' }[key];
  store.commit(msg);
}

// 미디어를 타임라인에
export function addMediaToTimeline(m, opt = {}) {
  if (store.mode === 'photo') { return; }
  const p = store.p;
  let c;
  if (m.kind === 'audio') {
    c = makeAudioClip(m, opt.time ?? store.t);
    placeClip(p, c, opt.track && opt.track.kind === 'audio' ? opt.track : null);
  } else {
    c = makeMediaClip(m, opt.time ?? 0, p);
    if (opt.track && opt.track.kind === 'overlay') { c.start = opt.time ?? store.t; placeClip(p, c, opt.track); }
    else addToMain(p, c, opt.time ?? null);
  }
  if (!opt.silent) {
    store.select(c.id);
    store.commit((m.kind === 'audio' ? '오디오를' : m.kind === 'image' ? '사진을' : '영상을') + ' 타임라인에 넣었어요');
    if (m.kind !== 'audio') store.setTime(c.start);
  }
  return c;
}
export function addManyToTimeline(list) {
  if (!list.length) return;
  let first = null;
  for (const m of list) { const c = addMediaToTimeline(m, { silent: true }); first ||= c; }
  store.commit(list.length > 1 ? `${list.length}개를 타임라인에 넣었어요` : '타임라인에 넣었어요');
  if (first) store.setTime(first.start);
}
export function addText(presetId, content) {
  const p = store.p;
  const c = makeTextClip(presetId, store.mode === 'photo' ? 0 : store.t, p, content);
  if (store.mode === 'photo') c.dur = 1;
  placeClip(p, c, null);
  store.select(c.id);
  store.commit('텍스트를 넣었어요. 미리보기에서 두 번 눌러 글을 고치세요');
}
export function addSticker(emoji) {
  const p = store.p;
  const c = makeStickerClip(emoji, store.mode === 'photo' ? 0 : store.t, p);
  if (store.mode === 'photo') { c.dur = 1; c.anim.in.type = 'none'; }
  placeClip(p, c, null);
  store.select(c.id);
  store.commit('스티커를 넣었어요');
}

// 전환
export function setTransition(clipId, type, dur) {
  const f = findClip(store.p, clipId);
  if (!f) return;
  f.clip.transition = { type, dur: dur ?? f.clip.transition?.dur ?? 0.6 };
  store.selectTrans(clipId);
  store.commit(`'${TRANS_NAME[type]}' 전환을 넣었어요`);
}
export function removeTransition(clipId) {
  const f = findClip(store.p, clipId);
  if (!f) return;
  f.clip.transition = null;
  store.select(null);
  store.commit('전환을 지웠어요', { undoHint: true });
}
export function clickBoundary(clipId) {
  const f = findClip(store.p, clipId);
  if (!f) return;
  if (!f.clip.transition) setTransition(clipId, 'dissolve', 0.6);
  else store.selectTrans(clipId);
  store.emit('openTab', 'trans');
}
export function applyTransitionSmart(type) {
  if (needVideo()) return;
  const bds = mainBoundaries(store.p);
  if (!bds.length) { toast('메인 트랙에 붙어 있는 클립이 두 개 이상 있어야 해요'); return; }
  let target = null;
  if (store.selTrans) target = bds.find((b) => b.a.id === store.selTrans);
  const f = sel();
  if (!target && f) target = bds.find((b) => b.a.id === f.clip.id) || bds.find((b) => b.b.id === f.clip.id);
  if (!target) target = bds.reduce((a, b) => (Math.abs(b.t - store.t) < Math.abs(a.t - store.t) ? b : a));
  setTransition(target.a.id, type);
}
export function applyTransitionAll(type, dur) {
  const bds = mainBoundaries(store.p);
  for (const b of bds) b.a.transition = { type, dur };
  store.commit(`경계 ${bds.length}곳에 전환을 넣었어요`);
}

// 필터
export function visualTarget() {
  const f = sel();
  if (f && (f.clip.type === 'video' || f.clip.type === 'image' || f.clip.type === 'collage')) return f;
  if (store.mode === 'photo') { const tr = mainTrack(store.p); return tr.clips[0] ? findClip(store.p, tr.clips[0].id) : null; }
  const tr = mainTrack(store.p);
  const c = tr.clips.find((x) => store.t >= x.start && store.t < clipEnd(x));
  return c ? findClip(store.p, c.id) : null;
}
export function applyFilter(id) {
  const f = visualTarget();
  if (!f) { toast('필터를 넣을 사진·영상 클립을 고르세요'); return; }
  f.clip.filter = { id, strength: f.clip.filter?.strength ?? 1 };
  if (id !== 'none' && !(f.clip.filter.strength > 0)) f.clip.filter.strength = 1;
  if (store.mode !== 'photo' && store.sel !== f.clip.id) store.select(f.clip.id);
  store.commit(id === 'none' ? '필터를 뺐어요' : `'${FILTER_MAP[id].name}' 필터를 넣었어요`);
}

// 영상에서 오디오 분리
export function detachAudio(clipId) {
  const f = findClip(store.p, clipId);
  if (!f || f.clip.type !== 'video') return;
  const m = media.get(f.clip.mediaId);
  if (!m || !m.hasAudio) { toast('이 영상에는 소리가 없어요'); return; }
  const c = f.clip;
  const a = { id: uid('c'), type: 'audio', mediaId: c.mediaId, name: (c.name || '영상') + ' 소리', start: c.start, dur: c.dur, in: c.in, speed: c.speed, volume: c.volume, fadeIn: c.fadeIn, fadeOut: c.fadeOut, muted: false, disabled: false };
  c.muted = true;
  placeClip(store.p, a, null);
  store.commit('소리를 오디오 트랙으로 분리했어요');
}

// 마이크 녹음
let rec = null;
export async function toggleRecord() {
  if (needVideo()) return;
  const btn = document.getElementById('btn-rec');
  if (rec) { rec.mr.stop(); return; }
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { toast('이 브라우저는 녹음을 지원하지 않아요'); return; }
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch (e) { toast('마이크를 쓸 수 없어요. 주소창 옆에서 마이크를 허용해 주세요', { type: 'err' }); return; }
  const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find((t) => MediaRecorder.isTypeSupported(t)) || '';
  const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks = [];
  const at = store.t;
  rec = { mr, at };
  mr.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  mr.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    btn?.classList.remove('recording');
    rec = null;
    const blob = new Blob(chunks, { type: mr.mimeType || 'audio/webm' });
    if (blob.size < 200) { toast('녹음된 소리가 없어요'); return; }
    if (blob.size > 200 * 1024 * 1024) { toast('녹음이 너무 길어요'); return; }
    try {
      const m = await importFile(blob, { trusted: true, kind: 'audio', name: '녹음 ' + new Date().toLocaleTimeString('ko-KR') });
      store.emit('media');
      addMediaToTimeline(m, { time: at });
    } catch (e) { toast('녹음을 넣지 못했어요', { type: 'err' }); }
  };
  mr.start();
  btn?.classList.add('recording');
  toast('녹음 중이에요. 녹음 버튼을 다시 누르면 멈춰요', { ms: 3500 });
}

export { FPS };

// ── 분할 화면(콜라주) ──
export function activeCollage() {
  const p = store.p;
  if (!p) return null;
  let f = store.selected();
  if (!f && store.mode === 'photo') { const tr = mainTrack(p); if (tr && tr.clips[0]) f = findClip(p, tr.clips[0].id); }
  return f && f.clip.type === 'collage' ? f : null;
}
export function selectCell(clipId, idx) { store.cellSel = idx == null ? null : { clipId, idx }; store.emit('cellsel'); }
export function selectedCell() {
  const f = activeCollage();
  if (!f || !store.cellSel || store.cellSel.clipId !== f.clip.id) return null;
  if (store.cellSel.idx >= cellCount(f.clip)) return null;
  return { f, idx: store.cellSel.idx };
}
function ensureCells(c) {
  const n = cellCount(c);
  c.collage.cells ||= [];
  while (c.collage.cells.length < n) c.collage.cells.push(newCell());
  return c.collage.cells;
}
const filledOk = (cell) => cell && cell.mediaId && media.has(cell.mediaId);
function firstEmpty(c, from = 0) {
  const cells = ensureCells(c), n = cellCount(c);
  for (let k = 0; k < n; k++) { const i = (from + k) % n; if (!filledOk(cells[i])) return i; }
  return -1;
}
function mediaOkForCell(m) {
  if (!m) return false;
  if (m.kind === 'audio') { toast('칸에는 사진·영상만 넣을 수 있어요'); return false; }
  if (store.mode === 'photo' && m.kind !== 'image') { toast('사진 콜라주에는 사진만 넣을 수 있어요'); return false; }
  return true;
}
export function addCollage(layoutId) {
  if (store.mode === 'photo') { import('./photo.js').then((ph) => ph.photoCollage(layoutId)); return; }
  const p = store.p;
  const c = makeCollageClip(layoutId, store.t, p);
  const main = mainTrack(p);
  if (!main.clips.length) addToMain(p, c, null);
  else { c.start = store.t; placeClip(p, c, null); }
  store.select(c.id);
  store.cellSel = { clipId: c.id, idx: 0 };
  store.commit(`'${LAYOUT_MAP[layoutId]?.name || '분할'}' 분할 화면을 넣었어요. 칸을 누르고 미디어를 누르면 채워져요`);
  store.setTime(c.start);
  store.emit('cellsel');
  return c;
}
export function setLayout(f, layoutId) {
  const c = f.clip;
  if (!LAYOUT_MAP[layoutId]) return;
  c.collage.layout = layoutId;
  ensureCells(c); // 이미 넣은 사진은 그대로(칸 수가 줄면 뒤쪽은 숨겨 두었다가 다시 늘리면 돌아온다)
  if (store.cellSel && store.cellSel.idx >= cellCount(c)) store.cellSel = null;
  store.commit(`레이아웃을 '${LAYOUT_MAP[layoutId].name}'(으)로 바꿨어요`);
}
// 칸 하나 채우기
export function fillCell(f, idx, m, opt = {}) {
  if (!mediaOkForCell(m)) return false;
  const cells = ensureCells(f.clip);
  cells[idx] = { ...newCell(), mediaId: m.id, muted: !!cells[idx]?.muted };
  if (!opt.silent) {
    const next = firstEmpty(f.clip, idx + 1);
    store.cellSel = next >= 0 ? { clipId: f.clip.id, idx: next } : { clipId: f.clip.id, idx };
    store.commit(`${idx + 1}번 칸에 '${m.name.slice(0, 20)}'을(를) 넣었어요`);
    store.emit('cellsel');
  }
  return true;
}
// 미디어 하나를 고른 칸(없으면 첫 빈 칸)에
export function fillFromMedia(m) {
  const f = activeCollage();
  if (!f) return false;
  const sc = selectedCell();
  let idx = sc ? sc.idx : firstEmpty(f.clip);
  if (idx < 0) { toast('빈 칸이 없어요. 바꿀 칸을 먼저 누르세요'); return true; }
  fillCell(f, idx, m);
  return true;
}
// 여러 장을 순서대로
export function fillMany(f, list) {
  const n = cellCount(f.clip);
  const ok = list.filter((m) => m && m.kind !== 'audio' && (store.mode !== 'photo' || m.kind === 'image'));
  if (!ok.length) { toast('넣을 사진·영상을 골라 주세요'); return; }
  ok.slice(0, n).forEach((m, i) => fillCell(f, i, m, { silent: true }));
  store.cellSel = { clipId: f.clip.id, idx: 0 };
  store.commit(ok.length > n ? `칸이 ${n}개라 앞의 ${n}개만 넣었어요` : `${ok.length}개를 순서대로 칸에 넣었어요`);
  store.emit('cellsel');
}
export function clearCell(f, idx) {
  const cells = ensureCells(f.clip);
  cells[idx] = newCell();
  store.commit(`${idx + 1}번 칸을 비웠어요`, { undoHint: true });
}
export function swapCells(f, i, j) {
  if (i === j) return;
  const cells = ensureCells(f.clip);
  [cells[i], cells[j]] = [cells[j], cells[i]];
  store.cellSel = { clipId: f.clip.id, idx: j };
  store.commit(`${i + 1}번과 ${j + 1}번 칸을 바꿨어요`);
  store.emit('cellsel');
}
