// 사진 편집 모드 + 자르기 창 (영상 모드와 같은 엔진 사용)
import { store } from './store.js';
import { h, toast, clamp, download, stamp } from './util.js';
import { icon } from './icons.js';
import { media } from './media.js';
import { newTrack, makeMediaClip, makeCollageClip, mainTrack, canvasSize, findClip } from './model.js';
import { thumbAt } from './media.js';
import { LAYOUT_MAP } from './collage.js';
import { renderFrame, imageSource, mediaGeom } from './render.js';
import { getPlayer } from './preview.js';

const MAX_SIDE = 4096;

function oriented(c, m) {
  const r = (((c.rot90 || 0) % 360) + 360) % 360;
  const rot = r === 90 || r === 270;
  return { OW: rot ? m.height : m.width, OH: rot ? m.width : m.height };
}
export function updatePhotoCanvas(p) {
  const c = mainTrack(p).clips[0];
  if (!c || c.type === 'collage') return;
  const m = media.get(c.mediaId);
  if (!m) return;
  const { OW, OH } = oriented(c, m);
  const ow = OW * c.crop.w, oh = OH * c.crop.h;
  const s = Math.min(1, MAX_SIDE / Math.max(ow, oh));
  p.w = Math.max(16, Math.round(ow * s)); p.h = Math.max(16, Math.round(oh * s));
}

export function openPhoto(m) {
  const p = {
    version: 1, name: '사진', aspect: 'custom', w: m.width, h: m.height, bg: '#000000', fitMode: 'fit',
    magnet: false, snap: true, exportRes: 1080, photo: true,
    tracks: [newTrack('text'), newTrack('main')],
  };
  const c = makeMediaClip(m, 0, p);
  c.dur = 1; c.fit = 'fit';
  mainTrack(p).clips.push(c);
  updatePhotoCanvas(p);
  store.photo = p;
  if (store.mode !== 'photo') setMode('photo');
  store.select(null);
  store.resetHistory();
  store.save();
  store.emit('project');
  store.emit('mode');
  toast('사진을 열었어요. 오른쪽에서 조정·필터·자르기를 해 보세요');
}

// ── 사진 콜라주 ──
export const COLLAGE_RATIOS = { '1:1': [2048, 2048], '4:5': [1638, 2048], '3:4': [1536, 2048], '9:16': [1152, 2048], '16:9': [2048, 1152] };
export function isPhotoCollage(p = store.photo) { const c = p && mainTrack(p)?.clips[0]; return !!(c && c.type === 'collage'); }
export function photoCollage(layoutId) {
  // 이미 콜라주를 만드는 중이면 레이아웃만 바꾼다(넣은 사진 유지)
  if (store.mode === 'photo' && isPhotoCollage()) {
    import('./actions.js').then((a) => { const f = findClip(store.photo, mainTrack(store.photo).clips[0].id); a.setLayout(f, layoutId); });
    return;
  }
  const [w, h0] = COLLAGE_RATIOS['1:1'];
  const p = {
    version: 1, name: '사진 콜라주', aspect: 'custom', w, h: h0, bg: '#ffffff', fitMode: 'fit',
    magnet: false, snap: true, exportRes: 1080, photo: true, collageRatio: '1:1',
    tracks: [newTrack('text'), newTrack('main')],
  };
  const c = makeCollageClip(layoutId, 0, p);
  c.dur = 1; c.anim.in.type = 'none';
  mainTrack(p).clips.push(c);
  store.photo = p;
  if (store.mode !== 'photo') setMode('photo');
  store.select(null);
  store.cellSel = { clipId: c.id, idx: 0 };
  store.resetHistory();
  store.save();
  store.emit('project');
  store.emit('mode');
  store.emit('cellsel');
  toast(`'${LAYOUT_MAP[layoutId]?.name || '콜라주'}' 콜라주를 만들었어요. 칸을 누르고 사진을 누르거나 "여러 장 한 번에 채우기"를 쓰세요`, { ms: 4500 });
}
export function setCollageRatio(key) {
  const p = store.photo;
  if (!p || !COLLAGE_RATIOS[key]) return;
  [p.w, p.h] = COLLAGE_RATIOS[key];
  p.collageRatio = key;
  store.commit(`콜라주 비율을 ${key}(으)로 바꿨어요`);
}

export function setMode(mode) {
  if (store.mode === mode) return;
  getPlayer()?.pause();
  store.mode = mode;
  store.sel = null; store.selTrans = null;
  if (mode === 'photo') store.t = 0;
  else store.t = Math.min(store.t, store.duration());
  if (!store.hist[mode].last && store.p) store.resetHistory();
  document.body.classList.toggle('photo-mode', mode === 'photo');
  store.save();
  store.emit('mode');
  store.emit('project');
  store.emit('select');
  store.emit('time');
}

// 자르기 비율 바로 적용(가운데 기준 가장 큰 영역)
const RATIO = { '1:1': 1, '9:16': 9 / 16, '16:9': 16 / 9, '4:5': 4 / 5, '3:4': 3 / 4 };
function ratioCrop(c, m, key) {
  const { OW, OH } = oriented(c, m);
  if (key === 'free') return { x: 0, y: 0, w: 1, h: 1 };
  const r = key === 'orig' ? OW / OH : RATIO[key];
  let w = OW, hh = OW / r;
  if (hh > OH) { hh = OH; w = OH * r; }
  return { x: (OW - w) / 2 / OW, y: (OH - hh) / 2 / OH, w: w / OW, h: hh / OH };
}
export function setCropRatio(c, key) {
  const m = media.get(c.mediaId);
  if (!m) return;
  c.cropRatio = key;
  c.crop = ratioCrop(c, m, key);
  if (store.mode === 'photo') updatePhotoCanvas(store.p);
  store.commit(key === 'free' ? '자르기를 없앴어요' : `${key === 'orig' ? '원본' : key} 비율로 잘랐어요`);
}
export function rotate90(c, deg) {
  const r0 = c.crop;
  c.rot90 = ((((c.rot90 || 0) + deg) % 360) + 360) % 360;
  // 자른 영역도 같이 돌린다
  c.crop = deg > 0 ? { x: 1 - r0.y - r0.h, y: r0.x, w: r0.h, h: r0.w } : { x: r0.y, y: 1 - r0.x - r0.w, w: r0.h, h: r0.w };
  if (c.cropRatio && !['free', 'orig', '1:1'].includes(c.cropRatio)) c.cropRatio = 'free';
  if (store.mode === 'photo') updatePhotoCanvas(store.p);
  store.commit(deg > 0 ? '오른쪽으로 90도 돌렸어요' : '왼쪽으로 90도 돌렸어요');
}

// ── 직접 자르기 창 ──
export function openCrop(c) {
  const m = media.get(c.mediaId);
  if (!m) return;
  const prov = getPlayer()?.sync;
  const src = c.type === 'image' ? imageSource(c) : prov?.get(c, store.t);
  if (!src) { toast('화면을 아직 불러오는 중이에요. 잠시 뒤 다시 눌러 주세요'); return; }
  const { OW, OH } = oriented(c, m);
  const maxW = Math.min(window.innerWidth * 0.86, 900), maxH = window.innerHeight * 0.62;
  const s = Math.min(maxW / OW, maxH / OH);
  const cw = Math.round(OW * s), ch = Math.round(OH * s);
  const cv = h('canvas', { width: String(cw), height: String(ch), class: 'crop-cv' });
  const x = cv.getContext('2d');
  // 회전만 반영한 전체 원본을 그린다
  const g = mediaGeom({ ...c, crop: { x: 0, y: 0, w: 1, h: 1 }, fit: 'fit', tf: { x: 0.5, y: 0.5, scale: 1, rot: 0 } }, m, cw, ch);
  x.save(); x.translate(cw / 2, ch / 2);
  const rr = g.r;
  const fx = src.w / g.sw, fy = src.h / g.sh;
  if (rr) x.rotate(rr * Math.PI / 180);
  const swap = rr === 90 || rr === 270;
  x.drawImage(src.img, 0, 0, g.sw * fx, g.sh * fy, -(swap ? ch : cw) / 2, -(swap ? cw : ch) / 2, swap ? ch : cw, swap ? cw : ch);
  x.restore();

  let cr = { ...c.crop }, ratioKey = c.cropRatio || 'free';
  const rect = h('div', { class: 'crop-rect' }, ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map((d) => h('i', { class: 'ch ' + d, dataset: { d } })), h('div', { class: 'crop-grid' }));
  const stageEl = h('div', { class: 'crop-stage', style: { width: cw + 'px', height: ch + 'px' } }, cv, rect);
  const place = () => Object.assign(rect.style, { left: cr.x * cw + 'px', top: cr.y * ch + 'px', width: cr.w * cw + 'px', height: cr.h * ch + 'px' });
  place();
  const ratioOf = () => (ratioKey === 'free' ? 0 : ratioKey === 'orig' ? OW / OH : RATIO[ratioKey]);
  const chips = h('div', { class: 'chip-grid' });
  const drawChips = () => chips.replaceChildren(...[['free', '자유'], ['orig', '원본'], ['1:1', '1:1'], ['9:16', '9:16'], ['16:9', '16:9'], ['4:5', '4:5'], ['3:4', '3:4']].map(([k, n]) =>
    h('button', { class: 'chip' + (ratioKey === k ? ' on' : ''), onclick: () => { ratioKey = k; if (k !== 'free') cr = ratioCrop(c, m, k); drawChips(); place(); } }, n)));
  drawChips();

  rect.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const d = e.target.dataset.d || 'move';
    const x0 = e.clientX, y0 = e.clientY, c0 = { ...cr };
    rect.setPointerCapture(e.pointerId);
    const R = ratioOf();
    const minW = 24 / cw, minH = 24 / ch;
    const mv = (ev) => {
      const dx = (ev.clientX - x0) / cw, dy = (ev.clientY - y0) / ch;
      let { x: l, y: t, w, h: hh } = c0;
      let r = l + w, b = t + hh;
      if (d === 'move') {
        l = clamp(c0.x + dx, 0, 1 - w); t = clamp(c0.y + dy, 0, 1 - hh);
        cr = { x: l, y: t, w, h: hh }; place(); return;
      }
      if (d.includes('w')) l = clamp(c0.x + dx, 0, r - minW);
      if (d.includes('e')) r = clamp(r + dx, l + minW, 1);
      if (d.includes('n')) t = clamp(c0.y + dy, 0, b - minH);
      if (d.includes('s')) b = clamp(b + dy, t + minH, 1);
      w = r - l; hh = b - t;
      if (R) {
        // 화면 비율 R = (w*OW)/(h*OH)
        const wantH = (w * OW / R) / OH;
        if (d === 'n' || d === 's') { const wantW = (hh * OH * R) / OW; w = Math.min(wantW, 1 - l); hh = (w * OW / R) / OH; }
        else { hh = Math.min(wantH, d.includes('n') ? b : 1 - t); w = (hh * OH * R) / OW; }
        if (d.includes('w')) l = r - w;
        if (d.includes('n')) t = b - hh;
        l = clamp(l, 0, 1 - w); t = clamp(t, 0, 1 - hh);
      }
      cr = { x: l, y: t, w, h: hh };
      place();
    };
    const up = () => { rect.removeEventListener('pointermove', mv); rect.removeEventListener('pointerup', up); rect.removeEventListener('pointercancel', up); };
    rect.addEventListener('pointermove', mv); rect.addEventListener('pointerup', up); rect.addEventListener('pointercancel', up);
  });

  const close = () => dlg.remove();
  const dlg = h('div', { class: 'modal-back', onclick: (e) => { if (e.target === dlg) close(); } },
    h('div', { class: 'modal crop-modal', role: 'dialog', 'aria-label': '자르기' },
      h('div', { class: 'modal-head' }, h('b', null, '자르기'), h('span', { class: 'muted' }, ' 모서리를 끌어 영역을 정하세요'), h('button', { class: 'ibtn', onclick: close, 'aria-label': '닫기' }, icon('close'))),
      chips, stageEl,
      h('div', { class: 'modal-foot' },
        h('button', { class: 'pbtn', onclick: () => { cr = { x: 0, y: 0, w: 1, h: 1 }; ratioKey = 'free'; drawChips(); place(); } }, icon('reset', 16), '처음으로'),
        h('button', { class: 'pbtn', onclick: close }, '취소'),
        h('button', { class: 'pbtn primary', onclick: () => {
          c.crop = cr; c.cropRatio = ratioKey;
          if (store.mode === 'photo') updatePhotoCanvas(store.p);
          close(); store.commit('잘랐어요', { undoHint: true });
        } }, icon('check', 16), '자르기 적용'))));
  document.body.append(dlg);
}

// ── 사진 모드 아래 도구줄 ──
export function initPhotoBar(el) {
  const photoClip = () => { const tr = store.p && mainTrack(store.p); return tr && tr.clips[0]; };
  const need = (fn) => () => { const c = photoClip(); if (!c) { toast('먼저 사진을 여세요'); return; } fn(c); };
  const needPhoto = (fn) => need((c) => { if (c.type === 'collage') { toast('콜라주는 칸을 끌어 위치를, 휠·슬라이더로 확대를 바꿔요'); return; } fn(c); });
  const tb = (ic, label, fn, tip) => h('button', { class: 'pbar-btn', dataset: { tip: tip || label }, onclick: fn }, icon(ic, 22), h('span', null, label));
  const cmp = tb('compare', '원본 비교', () => {}, '누르고 있는 동안 원본을 보여 줘요');
  cmp.addEventListener('pointerdown', (e) => { e.preventDefault(); store.compare = true; store.emit('render'); });
  const off = () => { if (store.compare) { store.compare = false; store.emit('render'); } };
  cmp.addEventListener('pointerup', off); cmp.addEventListener('pointerleave', off);
  el.append(h('div', { class: 'pbar' },
    tb('folder', '새 사진 열기', () => import('./panels.js').then((m) => m.pickPhoto())),
    h('span', { class: 'sep' }),
    tb('layout', '콜라주 만들기', () => import('./panels.js').then((m) => m.openTab('collage')), '사진 여러 장을 한 화면에'),
    h('span', { class: 'sep' }),
    tb('rotL', '왼쪽 90°', needPhoto((c) => rotate90(c, -90))),
    tb('rotR', '오른쪽 90°', needPhoto((c) => rotate90(c, 90))),
    tb('flipH', '좌우 뒤집기', need((c) => { c.tf.flipH = !c.tf.flipH; store.commit('좌우로 뒤집었어요'); })),
    tb('flipV', '상하 뒤집기', need((c) => { c.tf.flipV = !c.tf.flipV; store.commit('상하로 뒤집었어요'); })),
    tb('crop', '자르기', needPhoto((c) => openCrop(c))),
    cmp,
    h('span', { class: 'sep' }),
    tb('undo', '실행취소', () => store.undo(), '실행취소 (Ctrl+Z)'),
    tb('redo', '다시', () => store.redo(), '다시 실행 (Ctrl+Shift+Z)'),
    h('span', { class: 'sep' }),
    tb('save', 'PNG 저장', () => savePhoto('png')),
    tb('save', 'JPG 저장', () => savePhoto('jpg'))));
}

export async function renderPhotoBlob(type = 'png') {
  const p = store.photo;
  if (!p || !mainTrack(p).clips[0]) throw new Error('사진이 없어요');
  const { W, H } = canvasSize(p);
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  await waitFonts(p);
  const prov = { get: (c) => imageSource(c) || (() => { const th = thumbAt(media.get(c.mediaId), 0); return th ? { img: th, w: th.width, h: th.height } : null; })() };
  renderFrame(ctx, p, 0, prov, { W, H, k: 1, pw: W, ph: H, noAnim: true });
  if (type === 'jpg') {
    // 투명한 곳은 흰색 대신 배경색으로 이미 칠해져 있다
    return await new Promise((res) => cv.toBlob(res, 'image/jpeg', 0.92));
  }
  return await new Promise((res) => cv.toBlob(res, 'image/png'));
}
export async function savePhoto(type) {
  try {
    const b = await renderPhotoBlob(type);
    if (!b) throw new Error('만들기 실패');
    download(b, `갤러리컷_사진_${stamp()}.${type}`);
    toast(`${type.toUpperCase()}로 저장했어요 (다운로드 폴더)`);
  } catch (e) { toast('저장하지 못했어요: ' + e.message, { type: 'err' }); }
}
export async function waitFonts(p) {
  if (!document.fonts) return;
  const jobs = [];
  for (const tr of p.tracks) for (const c of tr.clips) if (c.type === 'text') jobs.push(document.fonts.load(`${c.text.bold ? '700' : '400'} 40px "${c.text.font}"`, c.text.content || '가'));
  try { await Promise.all(jobs); await document.fonts.ready; } catch (e) { /* 기본 글꼴로 */ }
}
export { findClip };
