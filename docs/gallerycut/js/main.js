// 갤러리컷 시작점
import { store, loadProjects } from './store.js';
import { h, $, toast, cleanText, MAX_NAME, debounce } from './util.js';
import { icon } from './icons.js';
import { db } from './db.js';
import { media, loadAllMedia } from './media.js';
import { ASPECTS, ASPECT_NAMES, findClip, projectDuration, canvasSize } from './model.js';
import { initPanels, importFiles, openTab } from './panels.js';
import { initPreview, getPlayer } from './preview.js';
import { initProps, setAspect } from './props.js';
import { initTimeline, tl } from './timeline.js';
import { initPhotoBar, setMode, renderPhotoBlob, updatePhotoCanvas } from './photo.js';
import { openExportDialog, exportVideo } from './export.js';
import { initShortcuts, openKeys } from './shortcuts.js';
import { startTour } from './onboard.js';
import * as act from './actions.js';
import { testRecord } from './screenrec.js';
import { applyLayoutClass, initMobile as initPhoneLayout } from './mobile.js';

function buildTopbar() {
  const bar = $('#topbar');
  const name = h('input', { class: 'proj-name', type: 'text', maxlength: String(MAX_NAME), 'aria-label': '프로젝트 이름', dataset: { tip: '프로젝트 이름(눌러서 바꾸기)' } });
  const syncName = () => { name.value = store.mode === 'photo' ? '사진 편집' : store.video.name; name.disabled = store.mode === 'photo'; };
  name.addEventListener('change', () => { store.video.name = cleanText(name.value, MAX_NAME).trim() || '제목 없는 프로젝트'; syncName(); store.commit(); });
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') name.blur(); });
  store.on('name', syncName); store.on('project', syncName); store.on('mode', syncName);

  const aspBtn = h('button', { class: 'tbtn-ratio', id: 'btn-aspect', dataset: { tip: '화면비 바꾸기' } });
  const syncAsp = () => {
    const a = store.mode === 'photo' ? '사진 비율' : store.video.aspect;
    const dims = ASPECTS[store.video.aspect] || [9, 16];
    const k = 16 / Math.max(dims[0], dims[1]);
    aspBtn.replaceChildren(h('i', { class: 'ratio-ic', style: { width: Math.round(dims[0] * k) + 'px', height: Math.round(dims[1] * k) + 'px' } }), h('span', null, a), h('span', { class: 'caret' }, '▾'));
    aspBtn.disabled = store.mode === 'photo';
  };
  aspBtn.addEventListener('click', () => {
    const old = $('.popover'); if (old) { old.remove(); return; }
    const r = aspBtn.getBoundingClientRect();
    const pop = h('div', { class: 'popover', style: { left: r.left + 'px', top: r.bottom + 6 + 'px' } },
      Object.keys(ASPECTS).map((a) => h('button', { class: 'pop-item' + (store.video.aspect === a ? ' on' : ''), onclick: () => { setAspect(a); pop.remove(); } }, h('b', null, a), h('span', { class: 'muted' }, ' ' + ASPECT_NAMES[a].replace(a, '').trim()))));
    document.body.append(pop);
    setTimeout(() => document.addEventListener('pointerdown', function off(e) { if (!pop.contains(e.target) && e.target !== aspBtn) { pop.remove(); document.removeEventListener('pointerdown', off); } }), 0);
  });
  store.on('project', syncAsp); store.on('mode', syncAsp);

  const modeSeg = h('div', { class: 'mode-seg', role: 'tablist' },
    h('button', { class: 'mode-btn', id: 'mode-video', dataset: { tip: '영상 편집 모드' }, onclick: () => setMode('video') }, icon('video', 16), '영상 편집'),
    h('button', { class: 'mode-btn', id: 'mode-photo', dataset: { tip: '사진 한 장 꾸미기 모드' }, onclick: () => { if (!store.photo) { setMode('photo'); toast('왼쪽 "사진 열기"로 사진을 골라 주세요'); } else setMode('photo'); } }, icon('image', 16), '사진 편집'));
  const syncMode = () => { $('#mode-video').classList.toggle('on', store.mode === 'video'); $('#mode-photo').classList.toggle('on', store.mode === 'photo'); };
  store.on('mode', syncMode);

  const saveDot = h('span', { class: 'save-state', id: 'save-state' });
  store.on('saved', () => {
    const s = store.saveState;
    saveDot.textContent = s === 'saved' ? '저장됨' : s === 'error' ? '저장 실패(용량?)' : '저장 중…';
    saveDot.className = 'save-state ' + s;
  });
  const exportBtn = h('button', { class: 'btn-export', id: 'btn-export', dataset: { tip: '완성 영상을 MP4로 저장' }, onclick: () => openExportDialog() }, icon('export', 18), h('span', { id: 'export-label' }, '내보내기'));
  store.on('mode', () => { $('#export-label').textContent = store.mode === 'photo' ? '사진 저장' : '내보내기'; exportBtn.dataset.tip = store.mode === 'photo' ? '사진을 PNG로 저장' : '완성 영상을 MP4로 저장'; });

  bar.append(
    h('div', { class: 'tb-left' }, h('div', { class: 'logo' }, icon('logo', 26), h('span', null, '갤러리컷')), name, saveDot),
    h('div', { class: 'tb-mid' }, modeSeg, aspBtn),
    h('div', { class: 'tb-right' },
      h('button', { class: 'ibtn', dataset: { tip: '실행취소', key: 'Ctrl+Z' }, onclick: () => store.undo() }, icon('undo')),
      h('button', { class: 'ibtn', dataset: { tip: '다시 실행', key: 'Ctrl+Shift+Z' }, onclick: () => store.redo() }, icon('redo')),
      h('button', { class: 'ibtn', id: 'btn-help', dataset: { tip: '단축키 표·도움말', key: '?' }, onclick: () => openKeys() }, icon('help')),
      exportBtn));
  syncName(); syncAsp();
}

// 화면 어디든 끌어다 놓기
function initDropZone() {
  const ov = $('#drop-overlay');
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; depth++; ov.classList.add('show'); e.preventDefault(); });
  window.addEventListener('dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) ov.classList.remove('show'); });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); depth = 0; ov.classList.remove('show');
    const files = [...(e.dataTransfer.files || [])];
    if (files.length) importFiles(files);
  });
}

// 한국어 툴팁(+단축키)
function initTips() {
  const tip = $('#tip');
  let timer = 0, cur = null;
  const hide = () => { clearTimeout(timer); tip.classList.remove('show'); cur = null; };
  document.addEventListener('pointerover', (e) => {
    if (e.pointerType !== 'mouse') return;
    const el = e.target.closest('[data-tip]');
    if (el === cur) return;
    hide();
    if (!el) return;
    cur = el;
    timer = setTimeout(() => {
      if (!el.isConnected) return;
      tip.replaceChildren(...[h('span', null, el.dataset.tip), el.dataset.key ? h('kbd', null, el.dataset.key) : null].filter(Boolean));
      const r = el.getBoundingClientRect();
      tip.classList.add('show');
      const tw = tip.offsetWidth, th = tip.offsetHeight;
      let x = r.left + r.width / 2 - tw / 2, y = r.top - th - 8;
      if (y < 4) y = r.bottom + 8;
      x = Math.max(4, Math.min(window.innerWidth - tw - 4, x));
      tip.style.left = x + 'px'; tip.style.top = y + 'px';
    }, 380);
  });
  document.addEventListener('pointerdown', hide, true);
  document.addEventListener('scroll', hide, true);
}

// 미리보기·타임라인 높이 조절
function initResizer() {
  const rz = $('#resizer'), bottom = $('#bottom');
  const saved = +(localStorageGet('nyangcut_tl_h') || 0);
  if (saved > 120) bottom.style.height = saved + 'px';
  rz.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    rz.setPointerCapture(e.pointerId);
    const y0 = e.clientY, h0 = bottom.offsetHeight;
    const mv = (ev) => { const nh = Math.max(140, Math.min(window.innerHeight * 0.7, h0 - (ev.clientY - y0))); bottom.style.height = nh + 'px'; };
    const up = () => { rz.removeEventListener('pointermove', mv); rz.removeEventListener('pointerup', up); localStorageSet('nyangcut_tl_h', String(bottom.offsetHeight)); };
    rz.addEventListener('pointermove', mv); rz.addEventListener('pointerup', up);
  });
}
function localStorageGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function localStorageSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* */ } }

// 좁은 화면: 아래 시트
function initMobile() {
  const bar = $('#mobilebar');
  const left = $('#left'), right = $('#right');
  const close = () => { left.classList.remove('sheet-open'); right.classList.remove('sheet-open'); bar.querySelectorAll('button').forEach((b) => b.classList.remove('on')); };
  const open = (which) => {
    const el = which === 'left' ? left : right;
    const was = el.classList.contains('sheet-open');
    close();
    if (!was) { el.classList.add('sheet-open'); bar.querySelector(`[data-s="${which}"]`)?.classList.add('on'); }
  };
  bar.append(
    h('button', { dataset: { s: 'left' }, onclick: () => open('left') }, icon('media', 20), h('span', null, '재료')),
    h('button', { dataset: { s: 'right' }, onclick: () => open('right') }, icon('adjust', 20), h('span', null, '편집')),
    h('button', { onclick: () => { close(); openExportDialog(); } }, icon('export', 20), h('span', null, '내보내기')));
  for (const el of [left, right]) el.prepend(h('button', { class: 'sheet-close', onclick: close, 'aria-label': '닫기' }, icon('close', 18)));
  store.on('sheet', (w) => { if (window.innerWidth <= 900 && w === 'left' && !document.body.classList.contains('m')) { left.classList.add('sheet-open'); } });
}

async function boot() {
  applyLayoutClass(); // 폰 배치 여부를 먼저 정한다
  buildTopbar();
  initPanels($('#left'));
  initPreview($('#center'), $('#media-holder'));
  initProps($('#right'));
  initTimeline($('#timeline'));
  initPhotoBar($('#photobar'));
  initDropZone();
  initTips();
  initResizer();
  initMobile();
  initPhoneLayout();
  initShortcuts();
  window.addEventListener('beforeunload', () => { /* IndexedDB에 이미 저장 중 */ });

  try {
    await loadAllMedia();
    await loadProjects();
    const mode = await db.get('kv', 'mode');
    if (store.photo) updatePhotoCanvas(store.photo);
    store.mode = mode === 'photo' && store.photo ? 'photo' : 'video';
  } catch (e) { console.warn(e); }
  document.body.classList.toggle('photo-mode', store.mode === 'photo');
  store.hist.video.last = JSON.stringify(store.video);
  if (store.photo) store.hist.photo.last = JSON.stringify(store.photo);
  store.emit('media');
  store.emit('mode');
  store.emit('project');
  store.emit('select');
  store.emit('time');
  store.saveState = 'saved'; store.emit('saved');
  document.fonts?.ready.then(() => store.emit('render'));
  requestAnimationFrame(() => { if (projectDuration(store.video) > 0) tl.fit(); });
  $('#app').classList.add('ready');
  setTimeout(() => startTour(false), 500);
}

// 시험용 훅(외부 전송 없음)
window.__nyangcut = {
  store, media, act, tl,
  get player() { return getPlayer(); },
  exportBlob: async (opt = {}) => (await exportVideo({ res: opt.res || 720, forceFallback: !!opt.fallback, onProgress: opt.onProgress || (() => {}) })).blob,
  exportResult: async (opt = {}) => exportVideo({ res: opt.res || 720, forceFallback: !!opt.fallback }),
  photoBlob: (type) => renderPhotoBlob(type),
  blobToBase64: async (b) => {
    const buf = new Uint8Array(await b.arrayBuffer());
    let s = '';
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return btoa(s);
  },
  findClip: (id) => findClip(store.p, id),
  canvasSize: () => canvasSize(store.p),
  openTab,
  testRecord, // 시험용: 가짜 스트림으로 화면 녹화 길 전체를 돌린다
};

boot();
export { debounce };
