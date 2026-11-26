// 아래 타임라인: 트랙·클립·끌기·트리밍·스냅·자석·확대축소·재생헤드
import { store } from './store.js';
import { h, clamp, FPS, fmtDur, toast } from './util.js';
import { icon } from './icons.js';
import { media, thumbAt } from './media.js';
import { drawCollage } from './collage.js';
import { openRecordDialog } from './screenrec.js';
import {
  clipEnd, maxDur, projectDuration, findClip, mainTrack, packMain, trackFree, accepts, insertTrack,
  sortTrack, KIND_LABEL, clipLabel, mainBoundaries, EPS, canvasSize,
} from './model.js';
import { TRANS_NAME, FILTER_MAP } from './effects.js';
import * as act from './actions.js';
import { getPlayer } from './preview.js';

let HEAD = 132;
const ROW_H = { text: 34, overlay: 46, main: 62, audio: 42 };
const ROW_H_M = { text: 34, overlay: 44, main: 58, audio: 38 };
let pps = 60;
let OFF = 0; // 폰 배치: 0초가 화면 가운데(재생헤드)에 오도록 비우는 왼쪽 여백
const isM = () => document.body.classList.contains('m');
let scroll, inner, rulerCv, playhead, snapLine, insertLine, zoomSlider, root;
let lanes = new Map(); // trackId → lane element

export const tl = {
  get pps() { return pps; },
  hit: hitTest,
  fit,
  zoomBy,
  highlight,
};

export function initTimeline(el) {
  root = el;
  const tb = (ic, tip, key, fn, extra = {}) => h('button', { class: 'ibtn', dataset: { tip, key: key || '' }, onclick: fn, ...extra }, icon(ic));
  zoomSlider = h('input', { type: 'range', min: '0', max: '1000', value: '400', class: 'zoom-slider', 'aria-label': '타임라인 확대', dataset: { tip: '타임라인 확대/축소', key: 'Ctrl+휠, +/-' } });
  zoomSlider.addEventListener('input', () => setPps(sliderToPps(+zoomSlider.value)));
  const magBtn = tb('magnet', '메인 트랙 자석: 켜면 클립 사이 틈을 자동으로 메워요', '', () => act.toggleMagnet(), { id: 'btn-magnet' });
  const snapBtn = tb('snap', '자동 스냅: 재생헤드·클립 끝에 착 붙어요', '', () => act.toggleSnap(), { id: 'btn-snap' });
  const recBtn = h('button', { class: 'ibtn rec', id: 'btn-rec', dataset: { tip: '마이크 녹음: 재생헤드 위치에 넣어요' }, onclick: () => act.toggleRecord() }, icon('mic'), h('span', { class: 'lbl' }, '녹음'));
  const scrBtn = h('button', { class: 'ibtn rec', id: 'btn-screenrec', dataset: { tip: '화면 녹화: 화면 전체·창·탭을 녹화해요', key: 'Ctrl+Shift+R' }, onclick: () => openRecordDialog() }, icon('screen'), h('span', { class: 'lbl' }, '화면 녹화'));
  const toolbar = h('div', { class: 'tl-toolbar' },
    h('div', { class: 'tl-tools' },
      tb('undo', '실행취소', 'Ctrl+Z', () => store.undo()),
      tb('redo', '다시 실행', 'Ctrl+Shift+Z', () => store.redo()),
      h('span', { class: 'sep' }),
      tb('split', '분할: 재생헤드 위치에서 자르기', 'Ctrl+B', () => act.split(), { id: 'btn-split' }),
      tb('trimL', '왼쪽 삭제: 재생헤드 왼쪽 부분 지우기', 'Q', () => act.trimSide('left')),
      tb('trimR', '오른쪽 삭제: 재생헤드 오른쪽 부분 지우기', 'W', () => act.trimSide('right')),
      tb('trash', '삭제', 'Delete', () => act.del(), { id: 'btn-del' }),
      tb('dup', '복제', 'Ctrl+D', () => act.duplicate()),
      tb('eyeToggle', '클립 켜기/끄기', 'V', () => act.toggleClip()),
      h('span', { class: 'sep' }),
      magBtn, snapBtn, recBtn, scrBtn),
    h('div', { class: 'tl-zoom' },
      tb('zoomOut', '축소', '-', () => zoomBy(1 / 1.4)),
      zoomSlider,
      tb('zoomIn', '확대', '+', () => zoomBy(1.4)),
      tb('fit', '전체 맞춤: 타임라인을 한눈에', '', () => fit())));
  scroll = h('div', { class: 'tl-scroll' });
  inner = h('div', { class: 'tl-inner' });
  scroll.append(inner);
  root.append(toolbar, scroll);

  scroll.addEventListener('scroll', () => {
    drawRuler();
    if (isM()) placeAdd();
    // 폰 배치: 재생헤드는 가운데 고정, 타임라인을 밀면 시간이 바뀐다
    if (isM() && !pinchBusy) {
      const t = scroll.scrollLeft / pps;
      if (Math.abs(scroll.scrollLeft - store.t * pps) > 1) store.setTime(t, 'mscroll');
    }
  });
  scroll.addEventListener('pointerdown', mDown, true);
  window.addEventListener('pointermove', mMove, true);
  window.addEventListener('pointerup', mUp, true);
  window.addEventListener('pointercancel', mUp, true);
  scroll.addEventListener('click', (e) => { if (isM() && Date.now() < noClickUntil) { e.stopPropagation(); e.preventDefault(); } }, true);
  scroll.addEventListener('wheel', (e) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const r = scroll.getBoundingClientRect();
      zoomBy(e.deltaY < 0 ? 1.18 : 1 / 1.18, e.clientX - r.left);
    } else if (e.shiftKey) { scroll.scrollLeft += e.deltaY; e.preventDefault(); }
  }, { passive: false });
  new ResizeObserver(() => { render(); }).observe(scroll);

  store.on('project', render);
  store.on('mode', render);
  store.on('select', markSel);
  store.on('time', (src) => { placePlayhead(); if (isM()) { if (src !== 'mscroll') syncScroll(); } else follow(); });
  store.on('layout', render);
  store.on('live', () => { /* 미리보기 조작 중엔 그대로 */ });
  store.on('flags', updateFlags);
  render();
}

function sliderToPps(v) { return 4 * Math.pow(600 / 4, v / 1000); }
function ppsToSlider(p) { return Math.round(Math.log(p / 4) / Math.log(600 / 4) * 1000); }
function setPps(n, anchorX) {
  const old = pps;
  n = clamp(n, 4, 600);
  if (Math.abs(n - old) < 1e-3) return;
  if (isM()) { pps = n; zoomSlider.value = String(ppsToSlider(pps)); render(); return; }
  const ax = anchorX ?? (scroll.clientWidth - HEAD) / 2 + HEAD;
  const tAt = (scroll.scrollLeft + ax - HEAD) / old;
  pps = n;
  zoomSlider.value = String(ppsToSlider(pps));
  render();
  scroll.scrollLeft = Math.max(0, tAt * pps - (ax - HEAD));
  drawRuler();
}
function zoomBy(f, anchorX) { setPps(pps * f, anchorX); }
function fit() {
  const d = Math.max(1, store.duration());
  if (isM()) { setPps(clamp((scroll.clientWidth - HEAD - 60) / d, 8, 160)); syncScroll(); return; }
  setPps((scroll.clientWidth - HEAD - 40) / d);
  scroll.scrollLeft = 0;
}

function updateFlags() {
  const p = store.p;
  if (!p) return;
  document.getElementById('btn-magnet')?.classList.toggle('on', !!p.magnet);
  document.getElementById('btn-snap')?.classList.toggle('on', !!p.snap);
}

const typeIcon = { video: 'video', image: 'image', audio: 'music', text: 'text', sticker: 'sticker', collage: 'layout' };
const kindIcon = { text: 'text', overlay: 'layers', main: 'video', audio: 'music' };

function render() {
  if (!scroll || store.mode === 'photo' || !store.p) return;
  const p = store.p;
  const mob = isM();
  HEAD = mob ? 40 : window.innerWidth <= 900 ? 96 : 132;
  updateFlags();
  const dur = projectDuration(p);
  const viewW = scroll.clientWidth || 800;
  OFF = mob ? Math.max(0, Math.round((viewW - HEAD) / 2)) : 0;
  const contentW = mob ? dur * pps + Math.max(0, viewW - HEAD - OFF) : Math.max(viewW - HEAD, (dur + 15) * pps);
  inner.replaceChildren();
  inner.style.width = HEAD + OFF + contentW + 'px';
  lanes = new Map();

  rulerCv = h('canvas', { class: 'tl-ruler', style: { left: HEAD + 'px' } });
  const rulerRow = h('div', { class: 'tl-row tl-ruler-row' }, h('div', { class: 'tl-head corner', style: mob ? { width: HEAD + 'px' } : null }, mob ? null : h('span', { class: 'muted small' }, '트랙')), rulerCv);
  rulerCv.addEventListener('pointerdown', seekDrag);
  inner.append(rulerRow);

  const kindCount = {};
  for (const tr of p.tracks) {
    kindCount[tr.kind] = (kindCount[tr.kind] || 0) + 1;
    const n = p.tracks.filter((t) => t.kind === tr.kind).length;
    const label = KIND_LABEL[tr.kind] + (n > 1 ? ' ' + kindCount[tr.kind] : '');
    const btns = [];
    if (tr.kind !== 'audio') btns.push(h('button', { class: 'tbtn' + (tr.hidden ? ' act' : ''), dataset: { tip: tr.hidden ? '트랙 보이기' : '트랙 숨기기' }, onclick: () => act.trackFlag(tr.id, 'hidden') }, icon(tr.hidden ? 'eyeOff' : 'eye', 16)));
    btns.push(h('button', { class: 'tbtn' + (tr.locked ? ' act' : ''), dataset: { tip: tr.locked ? '잠금 풀기' : '트랙 잠그기(편집 막기)' }, onclick: () => act.trackFlag(tr.id, 'locked') }, icon(tr.locked ? 'lock' : 'unlock', 16)));
    if (tr.kind !== 'text') btns.push(h('button', { class: 'tbtn' + (tr.muted ? ' act' : ''), dataset: { tip: tr.muted ? '소리 켜기' : '트랙 음소거' }, onclick: () => act.trackFlag(tr.id, 'muted') }, icon(tr.muted ? 'mute' : 'vol', 16)));
    const head = mob
      ? h('div', { class: 'tl-head m-head k-' + tr.kind, style: { width: HEAD + 'px' }, 'aria-label': label }, icon(kindIcon[tr.kind], 16))
      : h('div', { class: 'tl-head k-' + tr.kind, style: { width: HEAD + 'px' } },
        h('div', { class: 'tl-head-name' }, icon(kindIcon[tr.kind], 16), h('span', null, label), tr.kind === 'main' && p.magnet ? h('span', { class: 'mag-dot', dataset: { tip: '자석 켜짐' } }) : null),
        h('div', { class: 'tl-head-btns' }, btns));
    const lane = h('div', { class: 'tl-lane k-' + tr.kind + (tr.locked ? ' locked' : '') + (tr.hidden ? ' dim' : ''), dataset: { track: tr.id } });
    lane.style.width = contentW + 'px';
    if (OFF) lane.style.marginLeft = OFF + 'px';
    const row = h('div', { class: 'tl-row', style: { height: (mob ? ROW_H_M : ROW_H)[tr.kind] + 'px' } }, head, lane);
    inner.append(row);
    lanes.set(tr.id, lane);
    if (tr.kind === 'main' && !tr.clips.length && !mob) lane.append(h('div', { class: 'lane-hint' }, '여기로 사진·영상을 끌어 오세요'));
    if (tr.kind === 'main' && mob) {
      // 폰: 메인 트랙 끝의 큰 ＋ 버튼 → 갤러리 열기
      const endT = tr.clips.reduce((mx, c) => Math.max(mx, clipEnd(c)), 0);
      addBtn = h('button', { class: 'tl-add', id: 'm-add', 'aria-label': '사진·영상 추가', dataset: { end: String(endT) }, onclick: () => store.emit('pickGallery') }, icon('plus', 24));
      lane.append(addBtn);
    }
    for (const c of tr.clips) lane.append(clipEl(c, tr));
    if (tr.kind === 'main') {
      for (const bd of mainBoundaries(p)) {
        const has = !!bd.a.transition;
        const b = h('button', {
          class: 'tl-trans' + (has ? ' has' : '') + (store.selTrans === bd.a.id ? ' sel' : ''),
          dataset: { id: bd.a.id, tip: has ? `전환: ${TRANS_NAME[bd.a.transition.type]} (눌러서 고치기)` : '전환 넣기' },
          style: { left: bd.t * pps - 11 + 'px' },
        }, icon(has ? 'trans' : 'plus', 13));
        b.addEventListener('pointerdown', (e) => e.stopPropagation());
        b.addEventListener('click', (e) => { e.stopPropagation(); act.clickBoundary(bd.a.id); });
        lane.append(b);
      }
    }
    lane.addEventListener('pointerdown', onLaneDown);
  }
  playhead = h('div', { class: 'tl-playhead' }, h('div', { class: 'ph-knob' }));
  playhead.querySelector('.ph-knob').addEventListener('pointerdown', seekDrag);
  snapLine = h('div', { class: 'tl-snapline hidden' });
  insertLine = h('div', { class: 'tl-insertline hidden' });
  inner.append(playhead, snapLine, insertLine);
  placePlayhead();
  markSel();
  if (mob) { syncScroll(); placeAdd(); }
  requestAnimationFrame(() => { drawRuler(); drawClipCanvases(); });
}
// ＋ 버튼: 메인 트랙 끝에 붙되, 끝이 화면 밖이면 오른쪽 끝에 머문다
let addBtn = null;
function placeAdd() {
  if (!addBtn || !addBtn.isConnected) return;
  const endX = (+addBtn.dataset.end || 0) * pps + 10;
  const maxX = scroll.scrollLeft + (scroll.clientWidth - HEAD - OFF) - 54;
  addBtn.style.left = Math.max(0, Math.min(endX, maxX)) + 'px';
}
function syncScroll() {
  if (!scroll || !isM()) return;
  const want = store.t * pps;
  if (Math.abs(scroll.scrollLeft - want) > 1) scroll.scrollLeft = want;
}

function clipEl(c, tr) {
  const m = c.mediaId ? media.get(c.mediaId) : null;
  const sel = store.sel === c.id;
  const el = h('div', {
    class: `tl-clip t-${c.type}${sel ? ' sel' : ''}${c.disabled ? ' off' : ''}${!m && c.mediaId ? ' missing' : ''}`,
    dataset: { id: c.id },
    style: { left: c.start * pps + 'px', width: Math.max(2, c.dur * pps) + 'px' },
  });
  if (c.type === 'video' || c.type === 'image' || c.type === 'audio' || c.type === 'collage') el.append(h('canvas', { class: 'tl-cv' }));
  const badges = [];
  if (c.speed && c.speed !== 1) badges.push(h('span', { class: 'badge' }, c.speed + '배'));
  if (c.muted) badges.push(h('span', { class: 'badge' }, icon('mute', 11)));
  if (c.filter && c.filter.id !== 'none') badges.push(h('span', { class: 'badge' }, FILTER_MAP[c.filter.id]?.name || '필터'));
  if (c.anim && (c.anim.in.type !== 'none' || c.anim.out.type !== 'none')) badges.push(h('span', { class: 'badge' }, icon('anim', 11)));
  el.append(h('div', { class: 'tl-clip-label' }, icon(typeIcon[c.type], 12), h('span', { class: 'nm' }, !m && c.mediaId ? '(파일 없음) ' + clipLabel(c) : clipLabel(c)), h('span', { class: 'dur' }, fmtDur(c.dur)), badges));
  if (!tr.locked) el.append(h('div', { class: 'tl-h l', dataset: { trim: 'l' } }), h('div', { class: 'tl-h r', dataset: { trim: 'r' } }));
  return el;
}

function drawClipCanvases() {
  const p = store.p;
  if (!p) return;
  for (const [tid, lane] of lanes) {
    const tr = p.tracks.find((t) => t.id === tid);
    if (!tr) continue;
    for (const el of lane.querySelectorAll('.tl-clip')) {
      const c = tr.clips.find((x) => x.id === el.dataset.id);
      const cv = el.querySelector('.tl-cv');
      if (c && cv) drawClipCanvas(cv, c);
    }
  }
}
function drawCollageStrip(cv, c) {
  const W = Math.max(1, Math.min(8000, Math.round(c.dur * pps)));
  const H = cv.parentElement.clientHeight || 40;
  cv.width = W; cv.height = H;
  const x = cv.getContext('2d');
  const { W: PW, H: PH } = canvasSize(store.p);
  const tw = Math.max(8, H * PW / PH);
  const one = document.createElement('canvas');
  one.width = Math.max(2, Math.round(tw)); one.height = H;
  const ox = one.getContext('2d');
  ox.setTransform(one.width / PW, 0, 0, H / PH, 0, 0);
  drawCollage(ox, c, PW, PH, (v) => { const th = thumbAt(media.get(v.mediaId), v.in || 0); return th ? { img: th, w: th.width, h: th.height } : null; }, { cellFill: '#4a4a58' });
  for (let px = 0; px < W; px += tw) x.drawImage(one, px, 0, tw, H);
}
function drawClipCanvas(cv, c) {
  if (c.type === 'collage') { drawCollageStrip(cv, c); return; }
  const m = media.get(c.mediaId);
  const W = Math.max(1, Math.min(8000, Math.round(c.dur * pps)));
  const H = cv.parentElement.clientHeight || 40;
  cv.width = W; cv.height = H;
  const x = cv.getContext('2d');
  x.clearRect(0, 0, W, H);
  if (!m) return;
  const sc = W / (c.dur * pps);
  if (c.type === 'audio') {
    drawWave(x, m, c, W, H, sc, 'rgba(120,240,170,0.9)');
    return;
  }
  const first = thumbAt(m, c.in || 0);
  if (!first) return;
  const tw = Math.max(8, H * first.width / first.height);
  for (let px = 0; px < W; px += tw) {
    const t = (c.in || 0) + (px / sc / pps) * (c.speed || 1);
    const im = c.type === 'image' ? first : thumbAt(m, t);
    if (im) x.drawImage(im, px, 0, tw, H);
  }
  if (c.type === 'video' && m.peaks && !c.muted) {
    x.save(); x.globalAlpha = 0.9;
    x.fillStyle = 'rgba(0,0,0,0.35)'; x.fillRect(0, H * 0.72, W, H * 0.28);
    x.translate(0, H * 0.72);
    drawWave(x, m, c, W, H * 0.28, sc, 'rgba(160,230,255,0.85)');
    x.restore();
  }
}
function drawWave(x, m, c, W, H, sc, col) {
  if (!m.peaks) { x.fillStyle = col; x.fillRect(0, H / 2 - 1, W, 2); return; }
  x.fillStyle = col;
  const rate = m.peakRate || 50;
  for (let px = 0; px < W; px += 2) {
    const t = (c.in || 0) + (px / sc / pps) * (c.speed || 1);
    const v = m.peaks[Math.min(m.peaks.length - 1, Math.floor(t * rate))] || 0;
    const hh = Math.max(1, Math.min(1, v * (c.volume ?? 1)) * H * 0.9);
    x.fillRect(px, (H - hh) / 2, 1.5, hh);
  }
}

function drawRuler() {
  if (!rulerCv || !scroll) return;
  const w = Math.max(10, scroll.clientWidth - HEAD), hgt = 26;
  const dpr = window.devicePixelRatio || 1;
  rulerCv.width = Math.round(w * dpr); rulerCv.height = Math.round(hgt * dpr);
  rulerCv.style.width = w + 'px'; rulerCv.style.height = hgt + 'px';
  const x = rulerCv.getContext('2d');
  x.setTransform(dpr, 0, 0, dpr, 0, 0);
  x.clearRect(0, 0, w, hgt);
  const steps = [1 / FPS * 5, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  const major = steps.find((s) => s * pps >= 80) || 600;
  const minor = major / 5;
  const t0 = (scroll.scrollLeft - OFF) / pps, t1 = t0 + w / pps;
  x.strokeStyle = '#555a66'; x.fillStyle = '#9aa0ad';
  x.font = '11px "Noto Sans KR", sans-serif'; x.textBaseline = 'top';
  x.beginPath();
  for (let t = Math.floor(t0 / minor) * minor; t <= t1 + minor; t += minor) {
    if (t < -1e-6) continue;
    const px = Math.round((t - t0) * pps) + 0.5;
    const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
    x.moveTo(px, hgt); x.lineTo(px, isMajor ? hgt - 11 : hgt - 5);
    if (isMajor && t >= -1e-6) {
      const s = Math.round(t * 100) / 100;
      const mm = Math.floor(s / 60), ss = s - mm * 60;
      const lbl = major < 1 ? `${String(mm).padStart(2, '0')}:${ss.toFixed(2).padStart(5, '0')}` : `${String(mm).padStart(2, '0')}:${String(Math.round(ss)).padStart(2, '0')}`;
      x.fillText(lbl, px + 3, 2);
    }
  }
  x.stroke();
}

function placePlayhead() {
  if (!playhead) return;
  playhead.style.left = HEAD + OFF + store.t * pps + 'px';
}
function follow() {
  if (!store.playing || !scroll) return;
  const x = store.t * pps, l = scroll.scrollLeft, w = scroll.clientWidth - HEAD;
  if (x > l + w - 30 || x < l) scroll.scrollLeft = Math.max(0, x - 40);
}
function markSel() {
  if (!inner) return;
  root?.classList.toggle('has-sel', !!store.sel); // 폰: 고른 클립 손잡이를 전환 버튼이 가리지 않게
  for (const el of inner.querySelectorAll('.tl-clip')) el.classList.toggle('sel', el.dataset.id === store.sel);
  for (const el of inner.querySelectorAll('.tl-trans')) el.classList.toggle('sel', el.dataset.id === store.selTrans);
}
export function highlight(on) { root?.classList.toggle('drop-ready', !!on); }

function timeAtClientX(cx) {
  const r = scroll.getBoundingClientRect();
  return Math.max(0, (cx - r.left - HEAD - OFF + scroll.scrollLeft) / pps);
}
function seekDrag(e) {
  e.preventDefault(); e.stopPropagation();
  const tgt = e.currentTarget;
  try { tgt.setPointerCapture(e.pointerId); } catch (er) { /* */ }
  const go = (ev) => store.setTime(Math.min(timeAtClientX(ev.clientX), store.duration()));
  go(e);
  const up = () => { tgt.removeEventListener('pointermove', go); tgt.removeEventListener('pointerup', up); tgt.removeEventListener('pointercancel', up); };
  tgt.addEventListener('pointermove', go);
  tgt.addEventListener('pointerup', up);
  tgt.addEventListener('pointercancel', up);
}

// 화면 좌표 → 트랙/시각
function hitTest(cx, cy) {
  if (!scroll || store.mode === 'photo') return null;
  const r = scroll.getBoundingClientRect();
  if (cx < r.left || cx > r.right || cy < r.top || cy > r.bottom) return null;
  const p = store.p;
  let track = null;
  for (const [tid, lane] of lanes) {
    const lr = lane.getBoundingClientRect();
    if (cy >= lr.top && cy <= lr.bottom) { track = p.tracks.find((t) => t.id === tid); break; }
  }
  return { track, time: timeAtClientX(cx), x: cx };
}

function snapPoints(exceptId) {
  const pts = [0, store.t];
  for (const tr of store.p.tracks) for (const c of tr.clips) if (c.id !== exceptId) pts.push(c.start, clipEnd(c));
  return pts;
}
function snapTime(cands, exceptId) {
  // cands: [시각, ...] → {delta, at}
  if (!store.p.snap) return null;
  const th = 9 / pps;
  let best = null;
  for (const pt of snapPoints(exceptId)) for (const c of cands) {
    const d = pt - c;
    if (Math.abs(d) < th && (!best || Math.abs(d) < Math.abs(best.delta))) best = { delta: d, at: pt };
  }
  return best;
}
function showSnap(at) {
  if (at == null) { snapLine.classList.add('hidden'); return; }
  snapLine.classList.remove('hidden');
  snapLine.style.left = HEAD + OFF + at * pps + 'px';
}

function onLaneDown(e) {
  if (e.button !== 0) return;
  const lane = e.currentTarget;
  const clipNode = e.target.closest('.tl-clip');
  if (!clipNode) { store.select(null); return; }
  const p = store.p;
  const f = findClip(p, clipNode.dataset.id);
  if (!f) return;
  if (store.sel !== f.clip.id) store.select(f.clip.id);
  if (f.track.locked) { toast('잠긴 트랙이에요. 자물쇠를 눌러 풀어 주세요'); return; }
  e.preventDefault();
  const trim = e.target.dataset.trim;
  if (trim) startTrim(e, f, clipNode, trim);
  else startMove(e, f, clipNode, lane);
}

function startTrim(e, f, node, side) {
  const p = store.p, c = f.clip, tr = f.track;
  const o = { start: c.start, dur: c.dur, in: c.in || 0 };
  const sp = c.speed || 1;
  const x0 = e.clientX;
  const magnetMain = tr.kind === 'main' && p.magnet;
  sortTrack(tr);
  const idx = tr.clips.indexOf(c);
  const prevEnd = idx > 0 ? clipEnd(tr.clips[idx - 1]) : 0;
  const nextStart = idx < tr.clips.length - 1 ? tr.clips[idx + 1].start : Infinity;
  const hasSrc = c.type === 'video' || c.type === 'audio';
  const minD = 1 / FPS;
  try { node.setPointerCapture(e.pointerId); } catch (er) { /* */ }
  let moved = false;
  const move = (ev) => {
    const dt = (ev.clientX - x0) / pps;
    if (!moved && Math.abs(ev.clientX - x0) < 2) return;
    moved = true;
    let at = null;
    if (side === 'l') {
      let ns = o.start + dt;
      const sn = snapTime([ns], c.id); if (sn) { ns += sn.delta; at = sn.at; }
      let lo = magnetMain ? -Infinity : prevEnd;
      lo = Math.max(lo, 0);
      if (hasSrc) lo = Math.max(lo, o.start - o.in / sp);
      ns = clamp(ns, lo, o.start + o.dur - minD);
      const d = ns - o.start;
      c.start = ns; c.dur = o.dur - d;
      if ('in' in c) c.in = Math.max(0, o.in + d * sp);
    } else {
      let ne = o.start + o.dur + dt;
      const sn = snapTime([ne], c.id); if (sn) { ne += sn.delta; at = sn.at; }
      let hi = o.start + (hasSrc ? (maxDurFrom(c, o.in)) : 3600);
      if (!magnetMain) hi = Math.min(hi, nextStart);
      ne = clamp(ne, o.start + minD, hi);
      c.dur = ne - o.start;
    }
    showSnap(at);
    node.style.left = c.start * pps + 'px';
    node.style.width = Math.max(2, c.dur * pps) + 'px';
    const dl = node.querySelector('.dur'); if (dl) dl.textContent = fmtDur(c.dur);
    store.emit('render');
  };
  const up = () => {
    node.removeEventListener('pointermove', move);
    node.removeEventListener('pointerup', up);
    node.removeEventListener('pointercancel', up);
    showSnap(null);
    if (!moved) return;
    if (tr.kind === 'main') packMain(p);
    store.commit();
  };
  node.addEventListener('pointermove', move);
  node.addEventListener('pointerup', up);
  node.addEventListener('pointercancel', up);
}
function maxDurFrom(c, inPt) { const d = maxDur({ ...c, in: inPt }); return isFinite(d) ? d : 3600; }

function startMove(e, f, node, lane) {
  const p = store.p, c = f.clip, srcTr = f.track;
  const x0 = e.clientX, y0 = e.clientY;
  const o = { start: c.start };
  const pointerT0 = timeAtClientX(e.clientX);
  let moved = false, targetTr = srcTr, laneRect0 = lane.getBoundingClientRect();
  try { node.setPointerCapture(e.pointerId); } catch (er) { /* */ }
  const move = (ev) => {
    if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return;
    if (!moved) { moved = true; node.classList.add('dragging'); }
    let ns = Math.max(0, o.start + (ev.clientX - x0) / pps);
    let at = null;
    const sn = snapTime([ns, ns + c.dur], c.id);
    if (sn) { ns = Math.max(0, ns + sn.delta); at = sn.at; }
    showSnap(at);
    // 트랙 고르기
    const hit = hitTest(ev.clientX, ev.clientY);
    targetTr = hit && hit.track && accepts(hit.track.kind, c.type) && !hit.track.locked ? hit.track : (hit && !hit.track ? srcTr : targetTr);
    if (!accepts(targetTr.kind, c.type)) targetTr = srcTr;
    const tl2 = lanes.get(targetTr.id).getBoundingClientRect();
    node.style.transform = `translateY(${tl2.top - laneRect0.top}px)`;
    node.style.left = ns * pps + 'px';
    c._dragStart = ns;
    if (targetTr.kind === 'main' && p.magnet) {
      const pt = timeAtClientX(ev.clientX) - (pointerT0 - o.start) + c.dur / 2;
      const others = mainTrack(p).clips.filter((x) => x.id !== c.id).sort((a, b) => a.start - b.start);
      let ins = 0;
      for (const x of others) { if (pt > x.start + x.dur / 2) ins = clipEnd(x); }
      insertLine.classList.remove('hidden');
      insertLine.style.left = HEAD + OFF + ins * pps + 'px';
      insertLine.style.top = tl2.top - inner.getBoundingClientRect().top + 'px';
      insertLine.style.height = tl2.height + 'px';
    } else insertLine.classList.add('hidden');
  };
  const up = (ev) => {
    node.removeEventListener('pointermove', move);
    node.removeEventListener('pointerup', up);
    node.removeEventListener('pointercancel', up);
    showSnap(null); insertLine.classList.add('hidden');
    node.classList.remove('dragging', 'lifted');
    if (!moved) return;
    const ns = c._dragStart ?? c.start;
    delete c._dragStart;
    const pointerMid = timeAtClientX(ev.clientX) - (pointerT0 - o.start) + c.dur / 2;
    dropClip(c, srcTr, targetTr, ns, pointerMid);
  };
  node.addEventListener('pointermove', move);
  node.addEventListener('pointerup', up);
  node.addEventListener('pointercancel', up);
}

function dropClip(c, srcTr, targetTr, ns, mid) {
  const p = store.p;
  const removeFromSrc = () => { const i = srcTr.clips.indexOf(c); if (i >= 0) srcTr.clips.splice(i, 1); };
  if (targetTr.kind === 'main' && p.magnet) {
    removeFromSrc();
    const tr = mainTrack(p);
    sortTrack(tr);
    let idx = tr.clips.length;
    for (let i = 0; i < tr.clips.length; i++) if (mid < tr.clips[i].start + tr.clips[i].dur / 2) { idx = i; break; }
    tr.clips.splice(idx, 0, c);
    tr.clips.forEach((x, i) => { x.start = i; });
    packMain(p);
    if (srcTr.kind === 'main') packMain(p);
    store.commit();
    return;
  }
  if (trackFree(targetTr, ns, c.dur, c.id)) {
    removeFromSrc();
    c.start = ns;
    targetTr.clips.push(c); sortTrack(targetTr);
    if (srcTr.kind === 'main') packMain(p);
    store.commit();
    return;
  }
  if (targetTr.kind === 'main') {
    toast('다른 클립과 겹쳐서 놓을 수 없어요');
    store.emit('project');
    return;
  }
  // 겹치면 같은 종류의 새 트랙에
  removeFromSrc();
  c.start = ns;
  const nt = insertTrack(p, targetTr.kind);
  nt.clips.push(c);
  if (srcTr.kind === 'main') packMain(p);
  store.commit('겹쳐서 새 트랙에 놓았어요');
}

export { HEAD, EPS };

// ── 폰 배치 손가락 조작 ──
// 한 손가락 밀기 = 시간 이동(타임라인 스크롤), 두 손가락 = 확대·축소,
// 클립 톡 = 고르기, 클립 길게 누르기 = 들어서 옮기기, 고른 클립 양끝 손잡이 = 길이 줄이기
const gPts = new Map();
let g = null, pinchBusy = false, noClickUntil = 0, inertia = 0, pinchRaf = 0, pinchWant = 0;
const LONG_MS = 420;

function mDown(e) {
  if (!isM() || store.mode === 'photo') return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  // 고른 클립의 손잡이, 버튼(＋·전환)은 원래 처리로
  if (e.target.closest('.tl-h') || e.target.closest('button')) return;
  e.stopPropagation();
  cancelAnimationFrame(inertia);
  gPts.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (gPts.size === 1) {
    const clipNode = e.target.closest('.tl-clip');
    g = {
      mode: 'wait', id: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY,
      sl: scroll.scrollLeft, st: scroll.scrollTop, clipNode, lane: e.target.closest('.tl-lane'),
      timer: 0, vx: 0, lt: performance.now(), lx: e.clientX,
    };
    if (clipNode) g.timer = setTimeout(longPress, LONG_MS);
  } else if (gPts.size === 2 && g && g.mode !== 'drag') {
    clearTimeout(g.timer);
    const [a, b] = [...gPts.values()];
    g = { mode: 'pinch', d0: Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)), pps0: pps };
    pinchBusy = true;
  }
}

function mMove(e) {
  if (!gPts.has(e.pointerId)) return;
  gPts.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (!g) return;
  if (g.mode === 'pinch') {
    if (gPts.size < 2) return;
    const [a, b] = [...gPts.values()];
    pinchWant = clamp(g.pps0 * Math.hypot(a.x - b.x, a.y - b.y) / g.d0, 4, 600);
    if (!pinchRaf) pinchRaf = requestAnimationFrame(() => { pinchRaf = 0; setPps(pinchWant); });
    e.preventDefault();
    return;
  }
  if (e.pointerId !== g.id) return;
  g.x = e.clientX; g.y = e.clientY;
  if (g.mode === 'wait') {
    if (Math.hypot(g.x - g.x0, g.y - g.y0) < 8) return;
    clearTimeout(g.timer);
    g.mode = 'pan';
    if (store.playing) getPlayer()?.pause();
  }
  if (g.mode === 'pan') {
    e.preventDefault();
    scroll.scrollLeft = g.sl - (g.x - g.x0);
    scroll.scrollTop = g.st - (g.y - g.y0);
    const now = performance.now(), dt = Math.max(1, now - g.lt);
    g.vx = 0.8 * ((g.lx - g.x) / dt) + 0.2 * g.vx;
    g.lt = now; g.lx = g.x;
  }
}

function mUp(e) {
  if (!gPts.has(e.pointerId)) return;
  gPts.delete(e.pointerId);
  if (!g) return;
  if (g.mode === 'pinch') {
    if (gPts.size < 2) { pinchBusy = false; g = { mode: 'done' }; noClickUntil = Date.now() + 300; syncScroll(); }
    if (!gPts.size) g = null;
    return;
  }
  if (e.pointerId !== g.id) return;
  clearTimeout(g.timer);
  const st = g;
  g = null;
  if (st.mode === 'wait' && e.type === 'pointerup') tap(st);
  else if (st.mode === 'pan') {
    noClickUntil = Date.now() + 300;
    // 손을 떼도 조금 더 미끄러진다
    let v = st.vx * 16;
    if (Math.abs(v) > 2) {
      const step = () => {
        v *= 0.92;
        if (Math.abs(v) < 0.5) return;
        scroll.scrollLeft += v;
        inertia = requestAnimationFrame(step);
      };
      inertia = requestAnimationFrame(step);
    }
  }
}

function tap(st) {
  if (st.clipNode) {
    const id = st.clipNode.dataset.id;
    if (store.sel !== id) store.select(id);
  } else if (st.lane) store.select(null);
}

function longPress() {
  if (!g || g.mode !== 'wait' || !g.clipNode) return;
  const node = g.clipNode, lane = g.lane;
  const f = findClip(store.p, node.dataset.id);
  if (!f || !lane) return;
  if (store.sel !== f.clip.id) store.select(f.clip.id);
  if (f.track.locked) { toast('잠긴 트랙이에요'); g = null; return; }
  g.mode = 'drag';
  try { navigator.vibrate?.(15); } catch (er) { /* */ }
  if (store.playing) getPlayer()?.pause();
  // render()로 노드가 새로 만들어졌을 수 있다
  const cur = inner.querySelector(`.tl-clip[data-id="${CSS.escape(f.clip.id)}"]`) || node;
  const curLane = cur.closest('.tl-lane') || lane;
  cur.classList.add('lifted');
  noClickUntil = Date.now() + 600;
  startMove({ clientX: g.x, clientY: g.y, pointerId: g.id }, findClip(store.p, f.clip.id), cur, curLane);
  // 끌기는 startMove가 노드에서 받는다. 노드가 포인터를 못 잡는 경우(합성 이벤트) 창에서 넘겨준다
  const id = g.id;
  const fwd = (ev) => { if (ev.pointerId === id && ev.target !== cur && !cur.contains(ev.target)) cur.dispatchEvent(new PointerEvent(ev.type, ev)); };
  const end = (ev) => { if (ev.pointerId !== id) return; fwd(ev); window.removeEventListener('pointermove', fwd, true); window.removeEventListener('pointerup', end, true); window.removeEventListener('pointercancel', end, true); };
  window.addEventListener('pointermove', fwd, true);
  window.addEventListener('pointerup', end, true);
  window.addEventListener('pointercancel', end, true);
}
