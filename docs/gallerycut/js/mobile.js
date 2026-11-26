// 폰 배치(캡컷 폰 앱 방식): 위 막대 · 미리보기 · 가운데 재생헤드 타임라인 · 아래 도구줄 · 아래에서 올라오는 시트
// 가로 768px 미만이거나 손가락 기기면 body.m 을 켠다. PC 화면은 그대로 둔다.
import { store } from './store.js';
import { h, $, toast, download, stamp, fmtBytes } from './util.js';
import { icon } from './icons.js';
import { ASPECTS, mainTrack, findClip, clipEnd } from './model.js';
import { openTab, pickGallery, pickPhoto, leftTab } from './panels.js';
import { setAspect, setPropTab, propTabKey } from './props.js';
import { setMode, openCrop, rotate90, renderPhotoBlob } from './photo.js';
import { openExportDialog } from './export.js';
import { openTextEditor } from './preview.js';
import * as act from './actions.js';

const coarse = window.matchMedia ? matchMedia('(pointer: coarse) and (hover: none)') : null;
export const isMobile = () => document.body.classList.contains('m');
function wantMobile() { return window.innerWidth < 768 || !!(coarse && coarse.matches); }

// 부팅 맨 앞에서 한 번: 다른 화면을 그리기 전에 배치를 정한다
export function applyLayoutClass() {
  document.body.classList.toggle('m', wantMobile());
}

let L, R, tools, open = null, rightKind = null, lastSel = null, pendingTitle = null;

const LEFT_TITLE = { media: '미디어', collage: '분할 화면', audio: '오디오', text: '텍스트', sticker: '스티커', trans: '전환', filter: '필터', photo: '사진' };

export function initMobile() {
  L = $('#left'); R = $('#right'); tools = $('#m-tools');
  for (const el of [L, R]) el.prepend(sheetHead(el));
  buildTop();
  const relayout = () => {
    const m = wantMobile();
    if (m === isMobile()) return;
    document.body.classList.toggle('m', m);
    closeSheet();
    store.emit('layout');
    renderTools();
  };
  window.addEventListener('resize', relayout);
  coarse?.addEventListener?.('change', relayout);

  // 왼쪽 패널을 여는 신호(openTab) → 폰에서는 아래 시트로
  store.on('sheet', (w) => {
    if (!isMobile() || w !== 'left') return;
    if (store.selTrans && leftTab() === 'trans') { openSheet('right', '전환'); rightKind = 'trans'; return; }
    const tab = leftTab();
    const title = pendingTitle || (tab === 'media' && act.activeCollage() ? '칸 채우기' : LEFT_TITLE[tab] || '재료');
    pendingTitle = null;
    openSheet('left', title);
  });
  store.on('select', onSelect);
  store.on('mode', () => { if (isMobile()) { closeSheet(); renderTools(); } syncTop(); });
  store.on('project', () => { if (isMobile()) renderTools(); syncTop(); });
  store.on('layout', syncTop);
  renderTools();
  syncTop();
}

// ── 위 막대 ──
let mVideo, mPhoto, ratioBtn, exportLbl;
function buildTop() {
  const bar = $('#m-top');
  mVideo = h('button', { 'aria-label': '영상 편집', onclick: () => setMode('video') }, icon('video', 18));
  mPhoto = h('button', { 'aria-label': '사진 편집', onclick: () => setMode('photo') }, icon('image', 18));
  ratioBtn = h('button', { class: 'm-ratio', id: 'm-ratio', 'aria-label': '화면비', onclick: () => openAspectPop(ratioBtn) });
  exportLbl = h('span', null, '내보내기');
  bar.append(
    h('button', { class: 'm-ibtn', id: 'm-proj', 'aria-label': '프로젝트 설정', onclick: openProject }, icon('gear', 20)),
    h('div', { class: 'm-seg', role: 'tablist' }, mVideo, mPhoto),
    ratioBtn,
    h('span', { class: 'm-spacer' }),
    h('button', { class: 'm-ibtn', id: 'm-undo', 'aria-label': '되돌리기', onclick: () => store.undo() }, icon('undo', 20)),
    h('button', { class: 'm-ibtn', id: 'm-redo', 'aria-label': '다시 하기', onclick: () => store.redo() }, icon('redo', 20)),
    h('button', { class: 'm-export', id: 'm-export', onclick: () => (store.mode === 'photo' ? openPhotoSave() : openExportDialog()) }, icon('export', 16), exportLbl));
}
function syncTop() {
  if (!mVideo) return;
  mVideo.classList.toggle('on', store.mode === 'video');
  mPhoto.classList.toggle('on', store.mode === 'photo');
  ratioBtn.textContent = store.mode === 'photo' ? '사진' : store.video.aspect;
  ratioBtn.disabled = store.mode === 'photo';
  exportLbl.textContent = store.mode === 'photo' ? '저장' : '내보내기';
}
function openAspectPop(anchor) {
  const old = $('.popover'); if (old) { old.remove(); return; }
  const r = anchor.getBoundingClientRect();
  const pop = h('div', { class: 'popover m-pop', style: { left: Math.max(8, Math.min(window.innerWidth - 228, r.left)) + 'px', top: r.bottom + 6 + 'px' } },
    Object.keys(ASPECTS).map((a) => h('button', { class: 'pop-item' + (store.video.aspect === a ? ' on' : ''), onclick: () => { setAspect(a); pop.remove(); syncTop(); } }, h('b', null, a))));
  document.body.append(pop);
  setTimeout(() => document.addEventListener('pointerdown', function off(e) { if (!pop.contains(e.target) && e.target !== anchor) { pop.remove(); document.removeEventListener('pointerdown', off); } }), 0);
}
function openProject() {
  if (store.mode === 'photo') { openLeft('photo', '사진'); return; }
  store.select(null);
  openRightRaw('프로젝트 설정', 'project');
}

// ── 아래 시트 ──
function sheetHead(el) {
  const title = h('span', { class: 'm-sheet-title' }, '');
  const head = h('div', { class: 'm-sheet-head' }, h('span', { class: 'm-grip' }), title,
    h('button', { class: 'm-done', 'aria-label': '닫기', onclick: () => closeSheet() }, icon('check', 16), '완료'));
  // 끌어내려 닫기
  head.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    const y0 = e.clientY;
    let dy = 0;
    el.style.transition = 'none';
    try { head.setPointerCapture(e.pointerId); } catch (er) { /* */ }
    const mv = (ev) => { dy = Math.max(0, ev.clientY - y0); el.style.transform = `translateY(${dy}px)`; };
    const up = () => {
      head.removeEventListener('pointermove', mv); head.removeEventListener('pointerup', up); head.removeEventListener('pointercancel', up);
      el.style.transition = ''; el.style.transform = '';
      if (dy > 70) closeSheet();
    };
    head.addEventListener('pointermove', mv); head.addEventListener('pointerup', up); head.addEventListener('pointercancel', up);
  });
  return head;
}
function openSheet(side, title) {
  const el = side === 'left' ? L : R, other = side === 'left' ? R : L;
  other.classList.remove('m-open');
  el.classList.add('m-open');
  el.querySelector('.m-sheet-title').textContent = title;
  open = side;
  document.body.classList.add('m-sheet');
}
export function closeSheet() {
  L?.classList.remove('m-open'); R?.classList.remove('m-open');
  open = null; rightKind = null;
  document.body.classList.remove('m-sheet');
}
function openLeft(tab, title) { pendingTitle = title || null; openTab(tab); }
function openRightRaw(title, kind) { openSheet('right', title); rightKind = kind; }
function openRight(tab, title) {
  const key = propTabKey();
  if (key && tab) setPropTab(key, tab);
  openRightRaw(title, 'clip');
}

function onSelect() {
  if (!isMobile()) return;
  renderTools();
  if (store.selTrans) { openRightRaw('전환', 'trans'); lastSel = null; return; }
  const sel = store.sel;
  if (sel !== lastSel) {
    if (open === 'left' && sel) {
      const f = store.selected();
      if (f && f.clip.type === 'collage' && leftTab() === 'collage') openLeft('media', '칸 채우기');
      else if (!(leftTab() === 'media' && act.activeCollage())) closeSheet();
    }
    if (open === 'right' && rightKind === 'trans') closeSheet();
    else if (open === 'right' && !sel && rightKind === 'clip') closeSheet();
  }
  lastSel = sel;
}

// ── 아래 도구줄 ──
const T = (ic, label, fn, cls = '') => h('button', { class: 'm-tool ' + cls, dataset: { tool: label }, onclick: fn }, icon(ic, 24), h('span', null, label));

function mainAtPlayhead() {
  const tr = mainTrack(store.p);
  if (!tr || !tr.clips.length) return null;
  const c = tr.clips.find((x) => store.t >= x.start && store.t < clipEnd(x)) || tr.clips[tr.clips.length - 1];
  return c;
}
function withMain(fn) {
  return () => {
    const c = mainAtPlayhead();
    if (!c) { toast('먼저 ＋ 버튼으로 사진·영상을 넣어 주세요'); return; }
    store.select(c.id);
    fn(c);
  };
}
function photoMain() { const tr = store.photo && mainTrack(store.photo); return tr && tr.clips[0]; }

function renderTools() {
  if (!tools) return;
  tools.replaceChildren();
  if (!isMobile()) return;
  const scroller = h('div', { class: 'm-tools-scroll' });
  const photo = store.mode === 'photo';
  if (!store.p) { if (photo) { scroller.append(...photoTools()); tools.append(scroller); } return; }
  const f = store.selected();
  if (f && !(photo && f.track.kind === 'main')) {
    tools.append(h('button', { class: 'm-tool m-back', id: 'm-back', onclick: () => { store.select(null); closeSheet(); } }, icon('back', 24), h('span', null, '뒤로')));
    scroller.append(...clipTools(f));
  } else if (store.selTrans) {
    tools.append(h('button', { class: 'm-tool m-back', id: 'm-back', onclick: () => { store.select(null); closeSheet(); } }, icon('back', 24), h('span', null, '뒤로')));
    scroller.append(T('trans', '전환 바꾸기', () => openRightRaw('전환', 'trans')), T('trash', '전환 지우기', () => act.del(), 'danger'));
  } else if (photo) scroller.append(...photoTools());
  else scroller.append(...mainTools());
  tools.append(scroller);
}

function mainTools() {
  return [
    T('edit', '편집', withMain(() => {})),
    T('media', '미디어', () => openLeft('media')),
    T('music', '오디오', () => openLeft('audio')),
    T('text', '텍스트', () => openLeft('text')),
    T('sticker', '스티커', () => openLeft('sticker')),
    T('layout', '분할', () => openLeft('collage', '분할 화면')),
    T('trans', '전환', () => openLeft('trans')),
    T('filter', '필터', withMain(() => openRight('filter', '필터'))),
    T('adjust', '조정', withMain(() => openRight('adjust', '조정'))),
    T('fit', '화면비', () => { store.select(null); openRightRaw('화면비·프로젝트', 'project'); }),
    T('bg', '배경', withMain(() => openRight('bg', '배경'))),
    T('mic', '녹음', () => act.toggleRecord(), 'm-rec'),
  ];
}

function clipTools(f) {
  const c = f.clip, ty = c.type, photo = store.mode === 'photo', main = f.track.kind === 'main';
  const R2 = (ic, label, tab) => T(ic, label, () => openRight(tab, label));
  const splitB = T('split', '분할', () => act.split());
  const dup = T('dup', '복제', () => act.duplicate());
  const del = T('trash', '삭제', () => act.del(), 'danger');
  const pos = R2('layers', '위치·크기', 'basic');
  const out = [];
  if (ty === 'video') out.push(splitB, R2('speed', '속도', 'speed'), R2('vol', '볼륨', 'audio'), R2('anim', '애니메이션', 'anim'), R2('filter', '필터', 'filter'), R2('adjust', '조정', 'adjust'), R2('crop', '크롭', 'crop'), pos);
  else if (ty === 'image') out.push(splitB, R2('anim', '애니메이션', 'anim'), R2('filter', '필터', 'filter'), R2('adjust', '조정', 'adjust'), R2('crop', '크롭', 'crop'), pos);
  else if (ty === 'collage') out.push(R2('layout', '칸 채우기', 'collage'), splitB, R2('vol', '볼륨', 'audio'), R2('anim', '애니메이션', 'anim'), R2('filter', '필터', 'filter'), R2('adjust', '조정', 'adjust'), pos);
  else if (ty === 'text') {
    out.push(T('edit', '글 고치기', () => { closeSheet(); openTextEditor(c.id); }), R2('text', '스타일', 'text'), pos);
    if (!photo) out.push(R2('anim', '애니메이션', 'anim'), splitB);
  } else if (ty === 'sticker') {
    out.push(pos);
    if (!photo) out.push(R2('anim', '애니메이션', 'anim'), splitB);
  } else if (ty === 'audio') out.push(splitB, R2('vol', '볼륨', 'audio'), R2('speed', '속도', 'speed'));
  if (main && !photo && (ty === 'video' || ty === 'image' || ty === 'collage')) out.push(R2('bg', '배경', 'bg'));
  if (!photo) out.push(dup);
  out.push(del);
  return out;
}

function photoTools() {
  const c = photoMain();
  const col = c && c.type === 'collage';
  const need = (fn) => () => { const x = photoMain(); if (!x) { toast('먼저 "사진 열기"로 사진을 고르세요'); return; } fn(x); };
  const needPhoto = (fn) => need((x) => { if (x.type === 'collage') { toast('콜라주는 칸을 끌어 위치를, 두 손가락으로 확대를 바꿔요'); return; } fn(x); });
  const out = [
    T('folder', '사진 열기', () => pickPhoto()),
    T('layout', '콜라주', () => openLeft('collage', '콜라주')),
  ];
  if (col) out.push(T('layers', '칸', need(() => openRight('collage', '콜라주 칸'))));
  out.push(
    T('crop', '자르기', needPhoto((x) => openCrop(x))),
    T('rotR', '회전', needPhoto((x) => rotate90(x, 90))),
    T('adjust', '조정', need(() => openRight('adjust', '조정'))),
    T('filter', '필터', need(() => openRight('filter', '필터'))),
    T('text', '텍스트', need(() => openLeft('text'))),
    T('sticker', '스티커', need(() => openLeft('sticker'))),
    T('flipH', '뒤집기', need((x) => { x.tf.flipH = !x.tf.flipH; store.commit('좌우로 뒤집었어요'); })));
  return out;
}

// ── 사진 저장(폰): 만든 뒤 갤러리에 저장/공유, 안 되면 다운로드 ──
export function openPhotoSave() {
  if (!photoMain()) { toast('먼저 "사진 열기"로 사진을 고르세요'); return; }
  let type = 'jpg', blob = null, url = null, busy = false;
  const segBox = h('div', { class: 'seg' });
  const img = h('img', { class: 'ps-img', alt: '' });
  const info = h('div', { class: 'ex-info' }, '만드는 중…');
  const shareBtn = h('button', { class: 'pbtn primary big', id: 'ps-share' }, icon('save', 18), '갤러리에 저장/공유');
  const dlBtn = h('button', { class: 'pbtn big', id: 'ps-dl' }, icon('save', 18), '파일로 저장');
  const name = () => `갤러리컷_사진_${stamp()}.${type}`;
  const fileOf = () => new File([blob], name(), { type: type === 'jpg' ? 'image/jpeg' : 'image/png' });
  const canShare = () => { try { return !!(blob && navigator.canShare && navigator.share && navigator.canShare({ files: [fileOf()] })); } catch (e) { return false; } };
  const make = async () => {
    busy = true; shareBtn.disabled = true; dlBtn.disabled = true; info.textContent = '만드는 중…';
    try {
      blob = await renderPhotoBlob(type);
      if (url) URL.revokeObjectURL(url);
      url = URL.createObjectURL(blob); img.src = url;
      info.textContent = `${type.toUpperCase()} · ${fmtBytes(blob.size)}`;
      dlBtn.disabled = false;
      shareBtn.disabled = false;
      shareBtn.classList.toggle('hidden', !canShare());
    } catch (e) { info.textContent = '만들지 못했어요: ' + e.message; }
    busy = false;
  };
  const drawSeg = () => segBox.replaceChildren(...[['jpg', 'JPG (사진 앱용)'], ['png', 'PNG (선명하게)']].map(([k, n]) => h('button', { class: 'seg-btn' + (type === k ? ' on' : ''), onclick: () => { if (busy || type === k) return; type = k; drawSeg(); make(); } }, n)));
  drawSeg();
  shareBtn.addEventListener('click', async () => {
    if (!blob) return;
    try { await navigator.share({ files: [fileOf()], title: '갤러리컷' }); }
    catch (e) { if (e && e.name === 'AbortError') return; download(blob, name()); toast('공유가 안 돼서 파일로 저장했어요'); }
  });
  dlBtn.addEventListener('click', () => { if (blob) { download(blob, name()); toast('저장했어요 (다운로드 폴더)'); } });
  const close = () => { if (url) URL.revokeObjectURL(url); dlg.remove(); };
  const dlg = h('div', { class: 'modal-back', onclick: (e) => { if (e.target === dlg) close(); } },
    h('div', { class: 'modal ps-modal', role: 'dialog', 'aria-label': '사진 저장' },
      h('div', { class: 'modal-head' }, h('b', null, '사진 저장'), h('button', { class: 'ibtn', onclick: close, 'aria-label': '닫기' }, icon('close'))),
      segBox, img, info,
      h('p', { class: 'note' }, '아이폰: "갤러리에 저장/공유" → "이미지 저장"을 누르면 사진 앱에 들어가요.'),
      h('div', { class: 'modal-foot' }, dlBtn, shareBtn)));
  document.body.append(dlg);
  make();
}
export { pickGallery };
