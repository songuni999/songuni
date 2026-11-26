// 가운데 미리보기: 캔버스 + 선택 상자(이동·크기·회전) + 재생 조작
import { store } from './store.js';
import { h, $, fmtTime, clamp, cleanText, MAX_TEXT, FPS, toast } from './util.js';
import { icon } from './icons.js';
import { canvasSize, clipEnd, findClip } from './model.js';
import { clipBounds, fontStr } from './render.js';
import { Player } from './player.js';
import { media } from './media.js';
import { cellShapes, cellAt, coverGeom } from './collage.js';
import { activeCollage, swapCells } from './actions.js';

let cellLayer;
let player, box, overlay, selBox, guideV, guideH, stage, timeCur, timeDur, playBtn, editor;

export function getPlayer() { return player; }

function toCss() { const { W } = canvasSize(store.p); return box.clientWidth / W; }

export function initPreview(root, holder) {
  stage = h('div', { class: 'pv-stage' });
  const canvas = h('canvas', { class: 'pv-canvas' });
  overlay = h('div', { class: 'pv-overlay' });
  selBox = h('div', { class: 'sel-box hidden' },
    h('div', { class: 'hd nw', dataset: { h: 'scale' } }), h('div', { class: 'hd ne', dataset: { h: 'scale' } }),
    h('div', { class: 'hd sw', dataset: { h: 'scale' } }), h('div', { class: 'hd se', dataset: { h: 'scale' } }),
    h('div', { class: 'hd-rot-line' }), h('div', { class: 'hd rot', dataset: { h: 'rot', tip: '끌어서 회전' } }, icon('rotR', 14)));
  guideV = h('div', { class: 'guide v hidden' });
  guideH = h('div', { class: 'guide h hidden' });
  const emptyHint = h('div', { class: 'muted' }, '왼쪽 ＋ 상자로 사진·영상을 가져오세요');
  const empty = h('div', { class: 'pv-empty' },
    h('div', { class: 'pv-empty-icon' }, icon('media', 56)),
    h('div', null, '여기에 영상이 보여요'),
    emptyHint);
  cellLayer = h('div', { class: 'cg-layer hidden' });
  box = h('div', { class: 'pv-box' }, canvas, overlay, guideV, guideH, cellLayer, selBox, empty);
  stage.append(box);

  timeCur = h('span', { class: 'tc-cur' }, '00:00:00');
  timeDur = h('span', { class: 'tc-dur' }, '00:00:00');
  playBtn = h('button', { class: 'btn-play', dataset: { tip: '재생 / 정지', key: 'Space' }, onclick: () => player.toggle() }, icon('play', 22));
  const ctrls = h('div', { class: 'pv-ctrls' },
    h('div', { class: 'tc' }, timeCur, h('span', { class: 'muted' }, ' / '), timeDur),
    h('div', { class: 'pv-ctrl-mid' },
      h('button', { class: 'ibtn', dataset: { tip: '1프레임 뒤로', key: '←' }, onclick: () => store.setTime(store.t - 1 / FPS) }, icon('prev')),
      playBtn,
      h('button', { class: 'ibtn', dataset: { tip: '1프레임 앞으로', key: '→' }, onclick: () => store.setTime(store.t + 1 / FPS) }, icon('next'))),
    h('div', { class: 'pv-ctrl-right' },
      h('button', { class: 'ibtn', id: 'btn-compare-pv', dataset: { tip: '누르고 있는 동안 원본 보기' }, onpointerdown: (e) => { e.preventDefault(); store.compare = true; store.emit('render'); }, onpointerup: endCompare, onpointerleave: endCompare }, icon('compare')),
      h('button', { class: 'ibtn', dataset: { tip: '전체화면' }, onclick: fullscreen }, icon('full'))));
  root.append(stage, ctrls);

  player = new Player(canvas, holder);

  const relayout = () => {
    if (!store.p) return;
    const { W, H } = canvasSize(store.p);
    const sw = stage.clientWidth - 24, sh = stage.clientHeight - 24;
    if (sw <= 0 || sh <= 0) return;
    const s = Math.min(sw / W, sh / H);
    const cw = Math.max(40, Math.floor(W * s)), ch = Math.max(40, Math.floor(H * s));
    box.style.width = cw + 'px'; box.style.height = ch + 'px';
    player.layout(cw, ch);
    updateSel();
  };
  new ResizeObserver(relayout).observe(stage);
  store.on('project', () => { relayout(); updateEmpty(); updateTimes(); });
  store.on('mode', () => { relayout(); updateEmpty(); updateTimes(); });
  store.on('select', updateSel);
  store.on('drawn', updateSel);
  for (const ev of ['select', 'drawn', 'cellsel', 'play', 'mode']) store.on(ev, updateCells);
  cellLayer.addEventListener('pointerdown', cellDown);
  cellLayer.addEventListener('wheel', cellWheel, { passive: false });
  cellLayer.addEventListener('dblclick', cellDbl);
  store.on('time', updateTimes);
  store.on('play', () => { playBtn.replaceChildren(icon(store.playing ? 'pause' : 'play', 22)); });
  overlay.addEventListener('pointerdown', onDown);
  stage.addEventListener('pointerdown', (e) => {
    // 둘째 손가락이 그림 밖(검은 여백)에 닿아도 두 손가락 조작으로 친다
    if (e.pointerType === 'mouse' || pvPts.has(e.pointerId) || !pvPts.size) return;
    pvPts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pvPts.size >= 2 && !pinch) startPinch();
  });
  selBox.addEventListener('pointerdown', onDown);
  overlay.addEventListener('dblclick', onDbl);
  selBox.addEventListener('dblclick', onDbl);
  relayout(); updateEmpty(); updateTimes();

  function updateEmpty() {
    empty.classList.toggle('hidden', store.duration() > 0 || store.mode === 'photo');
    emptyHint.textContent = document.body.classList.contains('m') ? '아래 ＋ 버튼으로 사진·영상을 넣으세요' : '왼쪽 ＋ 상자로 사진·영상을 가져오세요';
  }
  store.on('layout', () => { relayout(); updateEmpty(); });
  // 두 손가락: 고른 클립 크기·회전
  window.addEventListener('pointermove', pinchMove, true);
  window.addEventListener('pointerup', pinchUp, true);
  window.addEventListener('pointercancel', pinchUp, true);
}
function endCompare() { if (store.compare) { store.compare = false; store.emit('render'); } }
function fullscreen() {
  try {
    if (document.fullscreenElement) document.exitFullscreen();
    else stage.requestFullscreen();
  } catch (e) { toast('전체화면을 쓸 수 없어요'); }
}
function updateTimes() {
  timeCur.textContent = fmtTime(store.t);
  timeDur.textContent = fmtTime(store.duration());
}

function visibleAt(c, t) { return !c.disabled && t >= c.start && t < clipEnd(c); }
function selectable(p) {
  const out = [];
  for (const tr of p.tracks) {
    if (tr.hidden || tr.locked || tr.kind === 'audio') continue;
    if (store.mode === 'photo' && tr.kind === 'main') continue;
    for (const c of tr.clips) if (visibleAt(c, store.t)) out.push(c);
  }
  return out;
}
function hitTest(px, py) {
  const p = store.p; const { W, H } = canvasSize(p);
  for (const c of selectable(p)) {
    const b = clipBounds(c, W, H);
    const a = -b.rot * Math.PI / 180;
    const dx = px - b.cx, dy = py - b.cy;
    const lx = dx * Math.cos(a) - dy * Math.sin(a), ly = dx * Math.sin(a) + dy * Math.cos(a);
    if (Math.abs(lx) <= b.w / 2 + 4 && Math.abs(ly) <= b.h / 2 + 4) return c;
  }
  return null;
}
function basePt(e) {
  const r = box.getBoundingClientRect();
  const s = toCss();
  return { x: (e.clientX - r.left) / s, y: (e.clientY - r.top) / s };
}

function updateSel() {
  if (!store.p || !box) return;
  const f = store.selected();
  if (!f || f.track.kind === 'audio' || !visibleAt(f.clip, store.t) || f.track.hidden || store.editingId === f.clip.id || (store.mode === 'photo' && f.track.kind === 'main')) {
    selBox.classList.add('hidden');
    return;
  }
  const { W, H } = canvasSize(store.p);
  const b = clipBounds(f.clip, W, H), s = toCss();
  selBox.classList.remove('hidden');
  selBox.classList.toggle('locked', !!f.track.locked);
  Object.assign(selBox.style, {
    left: b.cx * s + 'px', top: b.cy * s + 'px', width: Math.max(8, b.w * s) + 'px', height: Math.max(8, b.h * s) + 'px',
    transform: `translate(-50%,-50%) rotate(${b.rot}deg)`,
  });
}

// ── 두 손가락 크기·회전 ──
const pvPts = new Map();
let pinch = null, pinchUsed = false;
function startPinch() {
  const f = store.selected();
  if (!f || f.track.locked || f.track.kind === 'audio' || !visibleAt(f.clip, store.t)) return;
  if (store.mode === 'photo' && f.track.kind === 'main') return;
  const [a, b] = [...pvPts.values()];
  pinch = { c: f.clip, tf0: { ...f.clip.tf }, d0: Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)), a0: Math.atan2(b.y - a.y, b.x - a.x) };
  pinchUsed = true;
}
function pinchMove(e) {
  if (!pvPts.has(e.pointerId)) return;
  pvPts.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (!pinch || pvPts.size < 2) return;
  e.preventDefault();
  const [a, b] = [...pvPts.values()];
  const d = Math.hypot(a.x - b.x, a.y - b.y), ang = Math.atan2(b.y - a.y, b.x - a.x);
  const c = pinch.c;
  c.tf.scale = clamp(pinch.tf0.scale * d / pinch.d0, 0.05, 20);
  let deg = (pinch.tf0.rot || 0) + (ang - pinch.a0) * 180 / Math.PI;
  deg = ((deg + 180) % 360 + 360) % 360 - 180;
  for (const sn of [-180, -90, 0, 90, 180]) if (Math.abs(deg - sn) < 3) deg = sn;
  c.tf.rot = Math.round(deg * 10) / 10;
  store.emit('render'); store.emit('live');
}
function pinchUp(e) {
  if (!pvPts.has(e.pointerId)) return;
  pvPts.delete(e.pointerId);
  if (pinch && pvPts.size < 2) { pinch = null; store.commit(); }
}

function onDown(e) {
  if (e.button !== 0 || !store.p) return;
  if (editor) return;
  if (e.pointerType !== 'mouse') {
    pvPts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pvPts.size === 1) pinchUsed = false;
    if (pvPts.size >= 2) { e.preventDefault(); if (!pinch) startPinch(); return; }
  }
  const handle = e.target.closest('[data-h]')?.dataset.h;
  const pt = basePt(e);
  let f = store.selected();
  if (!handle) {
    const hit = hitTest(pt.x, pt.y);
    if (!hit) { store.select(null); return; }
    if (!f || f.clip.id !== hit.id) { store.select(hit.id); f = store.selected(); }
  }
  if (!f || f.track.locked) return;
  e.preventDefault();
  const c = f.clip, { W, H } = canvasSize(store.p);
  const b0 = clipBounds(c, W, H);
  const tf0 = { ...c.tf };
  const d0 = Math.hypot(pt.x - b0.cx, pt.y - b0.cy) || 1;
  const a0 = Math.atan2(pt.y - b0.cy, pt.x - b0.cx);
  const s = toCss();
  let moved = false;
  const target = e.currentTarget;
  try { target.setPointerCapture(e.pointerId); } catch (er) { /* */ }
  const move = (ev) => {
    if (pinchUsed) return; // 두 손가락으로 바뀌면 한 손가락 끌기는 멈춘다
    const q = basePt(ev);
    if (!moved && Math.hypot(q.x - pt.x, q.y - pt.y) * s < 3) return;
    moved = true;
    if (handle === 'scale') {
      const d = Math.hypot(q.x - b0.cx, q.y - b0.cy);
      c.tf.scale = clamp(tf0.scale * d / d0, 0.05, 20);
    } else if (handle === 'rot') {
      const a = Math.atan2(q.y - b0.cy, q.x - b0.cx);
      let deg = tf0.rot + (a - a0) * 180 / Math.PI;
      deg = ((deg + 180) % 360 + 360) % 360 - 180;
      for (const snap of [-180, -90, 0, 90, 180]) if (Math.abs(deg - snap) < 4) deg = snap;
      c.tf.rot = Math.round(deg * 10) / 10;
    } else {
      let nx = (tf0.x * W + (q.x - pt.x)), ny = (tf0.y * H + (q.y - pt.y));
      const th = 6 / s;
      const snapV = Math.abs(nx - W / 2) < th, snapH = Math.abs(ny - H / 2) < th;
      if (snapV) nx = W / 2;
      if (snapH) ny = H / 2;
      guideV.classList.toggle('hidden', !snapV);
      guideH.classList.toggle('hidden', !snapH);
      c.tf.x = nx / W; c.tf.y = ny / H;
    }
    store.emit('render');
    store.emit('live');
  };
  const up = () => {
    target.removeEventListener('pointermove', move);
    target.removeEventListener('pointerup', up);
    target.removeEventListener('pointercancel', up);
    guideV.classList.add('hidden'); guideH.classList.add('hidden');
    if (moved) store.commit();
  };
  target.addEventListener('pointermove', move);
  target.addEventListener('pointerup', up);
  target.addEventListener('pointercancel', up);
}

function onDbl(e) {
  const pt = basePt(e);
  const hit = hitTest(pt.x, pt.y);
  if (!hit || hit.type !== 'text') return;
  store.select(hit.id);
  openTextEditor(hit.id);
}

export function openTextEditor(id) {
  const f = findClip(store.p, id);
  if (!f || f.clip.type !== 'text' || !visibleAt(f.clip, store.t)) return;
  closeTextEditor();
  const c = f.clip, { W, H } = canvasSize(store.p), s = toCss();
  const b = clipBounds(c, W, H);
  const st = c.text;
  editor = h('textarea', { class: 'pv-editor', maxlength: String(MAX_TEXT), spellcheck: 'false', 'aria-label': '텍스트 고치기' });
  editor.value = st.content;
  const fs = st.size * c.tf.scale * s;
  Object.assign(editor.style, {
    left: b.cx * s + 'px', top: b.cy * s + 'px',
    width: Math.max(120, b.w * s + 40) + 'px', height: Math.max(fs * 1.6, b.h * s + 20) + 'px',
    font: fontStr(st, Math.max(10, fs)), color: st.color, textAlign: st.align || 'center',
    lineHeight: String(st.lineH || 1.25),
  });
  box.append(editor);
  store.editingId = id;
  store.emit('render'); updateSel();
  editor.focus(); editor.select();
  editor.addEventListener('input', () => {
    c.text.content = cleanText(editor.value, MAX_TEXT);
    store.emit('live');
  });
  editor.addEventListener('keydown', (ev) => {
    ev.stopPropagation();
    if (ev.key === 'Escape' || (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey))) { ev.preventDefault(); editor.blur(); }
  });
  editor.addEventListener('blur', () => closeTextEditor(true));
}
function closeTextEditor(commit) {
  if (!editor) return;
  const ed = editor; editor = null;
  ed.remove();
  store.editingId = null;
  if (commit) store.commit('글을 고쳤어요');
  store.emit('render'); updateSel();
}
export { $ };

// ── 분할 화면 칸 조작(칸 고르기·끌어서 위치·휠/핀치 확대·칸끼리 바꾸기) ──
function colFrame(f) {
  // 콜라주 그림(W×H)이 화면에 놓인 자리
  const { W, H } = canvasSize(store.p);
  const b = clipBounds(f.clip, W, H);
  return { W, H, b, k: b.w / W };
}
// 화면 좌표 → 어떤 분할 화면의 몇 번 칸인지(보이는 것 중 위에 있는 것부터)
export function collageCellAtClient(cx, cy) {
  if (!box || !store.p) return null;
  const r = box.getBoundingClientRect();
  if (cx < r.left || cx > r.right || cy < r.top || cy > r.bottom) return null;
  const s = toCss();
  const px = (cx - r.left) / s, py = (cy - r.top) / s;
  const p = store.p;
  for (const tr of p.tracks) {
    if (tr.hidden || tr.locked || tr.kind === 'audio' || tr.kind === 'text') continue;
    for (const c of tr.clips) {
      if (c.type !== 'collage' || !visibleAt(c, store.t)) continue;
      const f = findClip(p, c.id);
      const { W, H, b, k } = colFrame(f);
      const a = -b.rot * Math.PI / 180;
      const dx = px - b.cx, dy = py - b.cy;
      let lx = dx * Math.cos(a) - dy * Math.sin(a), ly = dx * Math.sin(a) + dy * Math.cos(a);
      if (c.tf.flipH) lx = -lx;
      if (c.tf.flipV) ly = -ly;
      const u = lx / k + W / 2, v = ly / k + H / 2;
      const idx = cellAt(c, W, H, u, v);
      if (idx >= 0) return { f, idx };
    }
  }
  return null;
}
let flashKey = null;
export function flashCell(hit) {
  const key = hit ? hit.f.clip.id + ':' + hit.idx : null;
  if (key === flashKey) return;
  flashKey = key;
  cellLayer?.querySelectorAll('.cg-cell').forEach((el) => el.classList.toggle('drop', !!hit && el.dataset.clip === hit.f.clip.id && +el.dataset.idx === hit.idx));
  if (hit && (!cellLayer || cellLayer.classList.contains('hidden') || cellLayer.dataset.clip !== hit.f.clip.id)) {
    // 고르지 않은 분할 화면 위에 끌고 왔을 때: 그 클립을 골라 칸이 보이게
    store.select(hit.f.clip.id);
  }
}

function updateCells() {
  if (!cellLayer) return;
  const f = activeCollage();
  if (!f || store.playing || f.track.hidden || !visibleAt(f.clip, store.t)) { cellLayer.classList.add('hidden'); selBox.classList.remove('col-mode'); return; }
  const { W, H, b } = colFrame(f);
  const s = toCss();
  cellLayer.classList.remove('hidden');
  selBox.classList.add('col-mode');
  cellLayer.dataset.clip = f.clip.id;
  Object.assign(cellLayer.style, {
    left: b.cx * s + 'px', top: b.cy * s + 'px', width: Math.max(8, b.w * s) + 'px', height: Math.max(8, b.h * s) + 'px',
    transform: `translate(-50%,-50%) rotate(${b.rot}deg) scale(${f.clip.tf.flipH ? -1 : 1},${f.clip.tf.flipV ? -1 : 1})`,
  });
  const shapes = cellShapes(f.clip, W, H);
  const cells = f.clip.collage.cells || [];
  const sel = store.cellSel && store.cellSel.clipId === f.clip.id ? store.cellSel.idx : -1;
  const key = [f.clip.id, f.clip.collage.layout, f.clip.collage.gap, f.clip.collage.radius, Math.round(b.w * s), sel, ...shapes.map((_, i) => cells[i]?.mediaId || '-')].join('|');
  if (cellLayer.dataset.key === key) return;
  cellLayer.dataset.key = key;
  cellLayer.replaceChildren(...shapes.map((sh, i) => {
    const filled = !!(cells[i]?.mediaId && media.has(cells[i].mediaId));
    const st = { left: sh.bx / W * 100 + '%', top: sh.by / H * 100 + '%', width: sh.bw / W * 100 + '%', height: sh.bh / H * 100 + '%' };
    if (sh.t === 'c') st.borderRadius = '50%';
    else if (sh.t === 'r' && f.clip.collage.radius) st.borderRadius = Math.min(sh.bw, sh.bh, (f.clip.collage.radius * Math.min(W, H) / 1080) * 2) / 2 * s * (b.w / W) + 'px';
    if (sh.t === 'p') st.clipPath = 'polygon(' + sh.pts.map(([x, y]) => `${(x - sh.bx) / sh.bw * 100}% ${(y - sh.by) / sh.bh * 100}%`).join(',') + ')';
    const el = h('div', { class: 'cg-cell' + (i === sel ? ' on' : '') + (filled ? '' : ' empty') + (sh.t !== 'r' ? ' shaped' : ''), dataset: { idx: String(i), clip: f.clip.id, tip: filled ? '끌어서 위치 조정 · 휠로 확대 · 두 번 누르면 바꾸기' : '눌러서 고른 뒤 왼쪽 미디어를 누르세요' }, style: st },
      h('span', { class: 'cg-no' }, String(i + 1)),
      filled ? null : h('span', { class: 'cg-empty' }, h('b', null, '＋'), h('small', null, '사진·영상 넣기')));
    if (filled) el.append(h('button', { class: 'cg-swap', 'data-swap': '', dataset: { tip: '끌어서 다른 칸과 바꾸기' }, 'aria-label': '칸 바꾸기' }, icon('swap', 14)));
    return el;
  }));
}

function cellDown(e) {
  if (e.button !== 0 || editor) return;
  const cellEl = e.target.closest('.cg-cell');
  if (!cellEl) return;
  const f = activeCollage();
  if (!f) return;
  const pt = basePt(e);
  // 분할 화면 위에 있는 텍스트·스티커 등은 그쪽을 먼저 잡는다
  const top = hitTest(pt.x, pt.y);
  if (top && top.id !== f.clip.id) { store.select(top.id); onDown(e); return; }
  e.preventDefault(); e.stopPropagation();
  const idx = +cellEl.dataset.idx;
  if (!(store.cellSel && store.cellSel.clipId === f.clip.id && store.cellSel.idx === idx)) { store.cellSel = { clipId: f.clip.id, idx }; store.emit('cellsel'); }
  if (f.track.locked) return;
  const c = f.clip;
  const cell = c.collage.cells?.[idx];
  const filled = !!(cell && cell.mediaId && media.has(cell.mediaId));
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  try { cellLayer.setPointerCapture(e.pointerId); } catch (er) { /* */ }
  if (e.target.closest('[data-swap]') && filled) { startSwap(e, f, idx); return; }
  if (!filled) {
    if (!cellDown.tipShown) { toast(`${idx + 1}번 칸을 골랐어요. 왼쪽 미디어를 누르면 이 칸에 들어가요`); cellDown.tipShown = true; }
    if (store.mode === 'video') store.emit('openTab', 'media'); else store.emit('openTab', 'photo');
    pointers.delete(e.pointerId);
    return;
  }
  if (pointers.size > 1) return; // 두 번째 손가락: 핀치는 move에서
  const { W, H, k } = colFrame(f);
  const sh = cellShapes(c, W, H)[idx];
  const src = cellSrcSize(c, idx);
  const p0 = { px: cell.px || 0, py: cell.py || 0, zoom: cell.zoom || 1 };
  const x0 = e.clientX, y0 = e.clientY;
  const s = toCss();
  const rot = -(c.tf.rot || 0) * Math.PI / 180;
  let moved = false, pinch0 = 0;
  const move = (ev) => {
    if (!pointers.has(ev.pointerId)) return;
    pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (pointers.size >= 2) {
      const [a, b2] = [...pointers.values()];
      const d = Math.hypot(a.x - b2.x, a.y - b2.y);
      if (!pinch0) { pinch0 = d; p0.zoom = cell.zoom || 1; return; }
      cell.zoom = clamp(p0.zoom * d / pinch0, 1, 5);
      moved = true; store.emit('render');
      return;
    }
    let dx = (ev.clientX - x0) / s / k, dy = (ev.clientY - y0) / s / k;
    if (!moved && Math.hypot(dx, dy) * s * k < 3) return;
    moved = true;
    // 회전·뒤집기를 풀어 칸 안 방향으로
    [dx, dy] = [dx * Math.cos(rot) - dy * Math.sin(rot), dx * Math.sin(rot) + dy * Math.cos(rot)];
    if (c.tf.flipH) dx = -dx;
    if (c.tf.flipV) dy = -dy;
    if (!src) return;
    const g = coverGeom(sh, src.w, src.h, { ...cell, px: 0, py: 0 });
    if (g.mx > 0.5) cell.px = clamp(p0.px + dx / g.mx, -1, 1);
    if (g.my > 0.5) cell.py = clamp(p0.py + dy / g.my, -1, 1);
    store.emit('render');
  };
  const up = (ev) => {
    pointers.delete(ev.pointerId);
    if (pointers.size) return;
    cellLayer.removeEventListener('pointermove', move);
    cellLayer.removeEventListener('pointerup', up);
    cellLayer.removeEventListener('pointercancel', up);
    if (moved) store.commit();
  };
  cellLayer.addEventListener('pointermove', move);
  cellLayer.addEventListener('pointerup', up);
  cellLayer.addEventListener('pointercancel', up);
}
const pointers = new Map();
function cellSrcSize(c, idx) {
  const m = media.get(c.collage.cells?.[idx]?.mediaId);
  if (!m) return null;
  return { w: m.width || 16, h: m.height || 9 };
}
// 칸끼리 바꾸기: ⇄ 손잡이를 끌어 다른 칸에 놓기
function startSwap(e, f, from) {
  e.preventDefault();
  const ghost = h('div', { class: 'drag-ghost' }, h('span', null, `${from + 1}번 칸`));
  document.body.append(ghost);
  const move = (ev) => {
    ghost.style.left = ev.clientX + 'px'; ghost.style.top = ev.clientY + 'px';
    const hit = collageCellAtClient(ev.clientX, ev.clientY);
    cellLayer.querySelectorAll('.cg-cell').forEach((el) => el.classList.toggle('drop', !!hit && hit.f.clip.id === f.clip.id && +el.dataset.idx === hit.idx && hit.idx !== from));
  };
  const up = (ev) => {
    pointers.delete(ev.pointerId);
    ghost.remove();
    cellLayer.removeEventListener('pointermove', move);
    cellLayer.removeEventListener('pointerup', up);
    cellLayer.removeEventListener('pointercancel', up);
    cellLayer.querySelectorAll('.cg-cell.drop').forEach((el) => el.classList.remove('drop'));
    const hit = collageCellAtClient(ev.clientX, ev.clientY);
    if (hit && hit.f.clip.id === f.clip.id && hit.idx !== from) swapCells(f, from, hit.idx);
  };
  cellLayer.addEventListener('pointermove', move);
  cellLayer.addEventListener('pointerup', up);
  cellLayer.addEventListener('pointercancel', up);
}
let wheelTimer = 0;
function cellWheel(e) {
  const cellEl = e.target.closest('.cg-cell');
  const f = activeCollage();
  if (!cellEl || !f || f.track.locked) return;
  const idx = +cellEl.dataset.idx;
  const cell = f.clip.collage.cells?.[idx];
  if (!cell || !cell.mediaId) return;
  e.preventDefault();
  cell.zoom = clamp((cell.zoom || 1) * (e.deltaY < 0 ? 1.08 : 1 / 1.08), 1, 5);
  if (!(store.cellSel && store.cellSel.clipId === f.clip.id && store.cellSel.idx === idx)) { store.cellSel = { clipId: f.clip.id, idx }; store.emit('cellsel'); }
  store.emit('render');
  clearTimeout(wheelTimer);
  wheelTimer = setTimeout(() => store.commit(), 350);
}
function cellDbl(e) {
  const cellEl = e.target.closest('.cg-cell');
  if (!cellEl) return;
  e.stopPropagation();
  const f = activeCollage();
  if (!f) return;
  store.cellSel = { clipId: f.clip.id, idx: +cellEl.dataset.idx };
  store.emit('cellsel');
  store.emit('openTab', store.mode === 'photo' ? 'photo' : 'media');
  toast(`${+cellEl.dataset.idx + 1}번 칸을 바꿔요. 왼쪽에서 사진·영상을 누르세요`);
}
