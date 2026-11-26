// 왼쪽 재료 패널: 미디어·오디오·텍스트·스티커·전환·필터
import { store } from './store.js';
import { h, toast, fmtDur, fmtBytes } from './util.js';
import { icon } from './icons.js';
import { media, importFile, removeMedia, ACCEPT, ACCEPT_IMAGE } from './media.js';
import { TEXT_PRESETS, presetStyle, STICKERS, TRANSITIONS, FILTERS, effectiveFx } from './effects.js';
import { renderTextThumb, renderFilterThumb } from './render.js';
import { dragSource } from './drag.js';
import { tl } from './timeline.js';
import * as act from './actions.js';
import { mainBoundaries, findClip, mainTrack, clipEnd } from './model.js';
import { openPhoto, isPhotoCollage } from './photo.js';
import { LAYOUTS, drawLayoutThumb, cellCount } from './collage.js';
import { collageCellAtClient, flashCell } from './preview.js';
import { openRecordDialog } from './screenrec.js';

const TABS_VIDEO = [
  ['media', '미디어', 'media'], ['collage', '분할', 'layout'], ['audio', '오디오', 'music'], ['text', '텍스트', 'text'],
  ['sticker', '스티커', 'sticker'], ['trans', '전환', 'trans'], ['filter', '필터', 'filter'],
];
const TABS_PHOTO = [['photo', '사진', 'image'], ['collage', '콜라주', 'layout'], ['text', '텍스트', 'text'], ['sticker', '스티커', 'sticker'], ['filter', '필터', 'filter']];

let root, tabBar, body, current = 'media';
const fileInput = h('input', { type: 'file', multiple: true, accept: ACCEPT, hidden: true });
const photoInput = h('input', { type: 'file', accept: ACCEPT_IMAGE, hidden: true });
// 폰 갤러리(사진 앱)를 바로 여는 입력. 고른 파일은 importFile에서 확장자·내용·크기를 다시 검사한다
const galleryInput = h('input', { type: 'file', multiple: true, accept: 'image/*,video/*', hidden: true });
const canScreenRec = () => !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) && !document.body.classList.contains('m');

export function initPanels(el) {
  root = el;
  tabBar = h('div', { class: 'lp-tabs', role: 'tablist' });
  body = h('div', { class: 'lp-body' });
  root.append(tabBar, body, fileInput, photoInput, galleryInput);
  fileInput.addEventListener('change', () => { importFiles([...fileInput.files]); fileInput.value = ''; });
  galleryInput.addEventListener('change', () => { const fl = [...galleryInput.files]; galleryInput.value = ''; importFiles(fl, { append: true }); });
  store.on('pickGallery', () => pickGallery());
  store.on('layout', () => renderBody());
  photoInput.addEventListener('change', async () => { const f = photoInput.files[0]; photoInput.value = ''; if (f) await importPhoto(f); });
  store.on('media', () => { if (['media', 'audio', 'photo', 'collage'].includes(current)) renderBody(); });
  store.on('cellsel', () => { if (['media', 'photo', 'collage'].includes(current)) renderBody(); });
  store.on('mode', () => { current = store.mode === 'photo' ? 'photo' : 'media'; renderTabs(); renderBody(); });
  let lastCol = null;
  store.on('select', () => {
    const col = act.activeCollage()?.clip.id || null;
    if (current === 'filter' || (col !== lastCol && ['media', 'photo', 'collage'].includes(current))) renderBody();
    lastCol = col;
  });
  store.on('openTab', (t) => openTab(t));
  renderTabs(); renderBody();
}
export const leftTab = () => current;
export function openTab(t) { current = t; renderTabs(); renderBody(); store.emit('sheet', 'left'); }
export function pickFiles() { fileInput.accept = ACCEPT; fileInput.click(); }
export function pickPhoto() { photoInput.click(); }
export function pickGallery() { if (store.mode === 'photo') { photoInput.click(); return; } galleryInput.click(); }

function renderTabs() {
  const tabs = store.mode === 'photo' ? TABS_PHOTO : TABS_VIDEO;
  if (!tabs.some((t) => t[0] === current)) current = tabs[0][0];
  tabBar.replaceChildren(...tabs.map(([id, name, ic]) => h('button', {
    class: 'lp-tab' + (id === current ? ' on' : ''), role: 'tab', 'aria-selected': id === current ? 'true' : 'false',
    dataset: { tab: id }, onclick: () => openTab(id),
  }, icon(ic, 20), h('span', null, name))));
}

function renderBody() {
  body.replaceChildren();
  ({ media: mediaTab, collage: collageTab, audio: audioTab, text: textTab, sticker: stickerTab, trans: transTab, filter: filterTab, photo: photoTab }[current] || mediaTab)();
}

function importBox(label, sub, onClick) {
  return h('button', { class: 'import-box', id: 'import-box', onclick: onClick, dataset: { tip: '파일을 고르거나 화면 어디든 끌어다 놓으세요' } },
    h('span', { class: 'import-plus' }, '＋'),
    h('span', { class: 'import-title' }, label),
    h('span', { class: 'import-sub' }, sub));
}

// 파일 여러 개 가져오기
export async function importFiles(files, opt = {}) {
  if (!files.length) return;
  if (store.mode === 'photo') { const img = files.find((f) => /\.(jpe?g|png|webp|gif)$/i.test(f.name)); if (img) return importPhoto(img); toast('사진 파일을 넣어 주세요'); return; }
  const ok = [], bad = [];
  const box = document.getElementById('import-box');
  box?.classList.add('busy');
  for (let i = 0; i < files.length; i++) {
    toast(`가져오는 중… (${i + 1}/${files.length})`, { ms: 1500 });
    try { ok.push(await importFile(files[i])); }
    catch (e) { bad.push([files[i].name, e.message]); }
  }
  box?.classList.remove('busy');
  store.emit('media');
  for (const [n, r] of bad.slice(0, 3)) toast(`못 가져왔어요: ${n.slice(0, 30)} — ${r}`, { type: 'err', ms: 5000 });
  if (!ok.length) return;
  const wasEmpty = store.duration() === 0;
  if (wasEmpty) {
    const vis = ok.filter((m) => m.kind !== 'audio'), aud = ok.filter((m) => m.kind === 'audio');
    for (const m of vis) act.addMediaToTimeline(m, { silent: true });
    for (const m of aud) act.addMediaToTimeline(m, { silent: true, time: 0 });
    store.commit(ok.length > 1 ? `${ok.length}개를 가져와 타임라인에 넣었어요` : '가져와서 타임라인에 넣었어요');
    store.setTime(0);
    requestAnimationFrame(() => tl.fit());
  } else if (opt.append) {
    // 폰 ＋ 버튼: 메인 트랙 끝에 바로 붙인다
    const vis = ok.filter((m) => m.kind !== 'audio');
    if (vis.length) act.addManyToTimeline(vis);
  } else {
    toast(`${ok.length}개 가져왔어요. 눌러서 타임라인에 넣으세요`);
  }
}
async function importPhoto(f) {
  try {
    const m = await importFile(f);
    if (m.kind !== 'image') { toast('사진 파일이 아니에요'); return; }
    store.emit('media');
    openPhoto(m);
  } catch (e) { toast('못 가져왔어요: ' + e.message, { type: 'err' }); }
}

function mediaCard(m) {
  const add = () => { if (m.kind !== 'audio' && act.activeCollage()) { act.fillFromMedia(m); return; } act.addMediaToTimeline(m); };
  const thumb = m.kind === 'audio'
    ? h('div', { class: 'mc-thumb audio' }, icon('music', 30))
    : h('img', { class: 'mc-thumb', src: m.thumbUrl || '', alt: '', draggable: 'false' });
  const card = h('div', { class: 'media-card', dataset: { id: m.id, tip: '누르면 타임라인에 넣어요 · 끌어서 원하는 곳에 놓기' } },
    thumb,
    h('span', { class: 'mc-kind' }, icon(m.kind === 'image' ? 'image' : m.kind === 'audio' ? 'music' : 'video', 12)),
    m.kind !== 'image' ? h('span', { class: 'mc-dur' }, fmtDur(m.duration)) : null,
    h('span', { class: 'mc-add' }, icon('plus', 16)),
    h('button', { class: 'mc-del', 'data-nodrag': '', dataset: { tip: '목록에서 지우기' }, onclick: (e) => { e.stopPropagation(); deleteMedia(m); } }, icon('close', 12)),
    h('div', { class: 'mc-name', title: m.name }, m.name));
  dragSource(card, {
    ghost: () => (m.thumbUrl ? h('img', { src: m.thumbUrl, alt: '' }) : h('span', null, m.name)),
    onClick: add,
    onMove: (x, y) => { tl.highlight(!!tl.hit(x, y)); flashCell(m.kind !== 'audio' ? collageCellAtClient(x, y) : null); },
    onDrop: (x, y) => {
      tl.highlight(false); flashCell(null);
      // 미리보기의 분할 화면 칸 위에 놓으면 그 칸을 채운다
      const cell = m.kind !== 'audio' ? collageCellAtClient(x, y) : null;
      if (cell) { act.fillCell(cell.f, cell.idx, m); return; }
      const hit = tl.hit(x, y);
      if (hit) {
        act.addMediaToTimeline(m, { time: hit.time, track: hit.track });
        return;
      }
      const pv = document.querySelector('.pv-stage')?.getBoundingClientRect();
      if (pv && x >= pv.left && x <= pv.right && y >= pv.top && y <= pv.bottom) add();
    },
  });
  return card;
}
async function deleteMedia(m) {
  const used = [];
  for (const p of [store.video, store.photo]) if (p) for (const tr of p.tracks) for (const c of tr.clips) if (c.mediaId === m.id || (c.type === 'collage' && (c.collage.cells || []).some((x) => x.mediaId === m.id))) used.push(c);
  const msg = used.length ? `'${m.name}'을(를) 지우면 타임라인의 클립 ${used.length}개에서도 같이 빠져요. 이건 되돌릴 수 없어요. 지울까요?` : `'${m.name}'을(를) 목록에서 지울까요? (되돌릴 수 없어요)`;
  if (!confirm(msg)) return;
  for (const p of [store.video, store.photo]) if (p) for (const tr of p.tracks) {
    tr.clips = tr.clips.filter((c) => c.mediaId !== m.id);
    for (const c of tr.clips) if (c.type === 'collage') c.collage.cells = (c.collage.cells || []).map((x) => (x.mediaId === m.id ? { ...x, mediaId: null, px: 0, py: 0, zoom: 1 } : x));
  }
  await removeMedia(m.id);
  store.resetHistory();
  store.select(null);
  store.commit('파일을 지웠어요');
  store.emit('media');
}

function mediaTab() {
  const list = [...media.values()].filter((m) => m.kind !== 'audio' || true);
  body.append(importBox('사진·영상·음악 가져오기', '누르거나 끌어다 놓기 · jpg png webp gif mp4 webm mov mp3 wav m4a', () => pickFiles()));
  if (canScreenRec()) body.append(h('button', { class: 'wide-btn rec-wide', id: 'btn-screenrec-media', onclick: () => openRecordDialog(), dataset: { tip: '화면 전체·창·탭을 녹화해 미디어에 넣어요', key: 'Ctrl+Shift+R' } }, icon('screen', 16), '화면 녹화'));
  collageBanner();
  const vis = list.filter((m) => m.kind !== 'audio');
  const images = vis.filter((m) => m.kind === 'image');
  if (images.length >= 2) {
    body.append(h('button', { class: 'wide-btn', onclick: () => act.addManyToTimeline(images), dataset: { tip: '사진을 순서대로 3초씩 이어 붙여요' } }, icon('image', 16), `사진 ${images.length}장 슬라이드쇼로 넣기`));
  }
  if (!list.length) { body.append(h('p', { class: 'empty-note' }, '아직 가져온 파일이 없어요.')); return; }
  body.append(h('div', { class: 'media-grid' }, list.map(mediaCard)));
}
function audioTab() {
  body.append(importBox('음악·효과음 가져오기', 'mp3 wav m4a aac ogg · 누르면 재생헤드 위치에 들어가요', () => { fileInput.accept = '.mp3,.wav,.m4a,.aac,.ogg,audio/*'; fileInput.click(); }));
  body.append(h('button', { class: 'wide-btn', onclick: () => act.toggleRecord(), dataset: { tip: '마이크로 녹음해 재생헤드 위치에 넣어요' } }, icon('mic', 16), '마이크 녹음 시작/멈춤'));
  const f = store.selected();
  if (f && f.clip.type === 'video') body.append(h('button', { class: 'wide-btn', onclick: () => act.detachAudio(f.clip.id) }, icon('detach', 16), '고른 영상에서 소리 분리'));
  else body.append(h('p', { class: 'empty-note' }, '영상의 소리만 따로 쓰려면: 영상 클립을 고르고 오른쪽 "오디오" 탭에서 "소리 분리"를 누르세요.'));
  const list = [...media.values()].filter((m) => m.kind === 'audio');
  if (list.length) body.append(h('div', { class: 'media-grid' }, list.map(mediaCard)));
}
function photoTab() {
  body.append(importBox('사진 열기', 'jpg png webp gif · 한 장을 열어 꾸며요', () => pickPhoto()));
  body.append(h('button', { class: 'wide-btn accent', id: 'btn-make-collage', onclick: () => openTab('collage'), dataset: { tip: '사진 여러 장을 한 화면에 나눠 넣어요' } }, icon('layout', 16), '콜라주 만들기'));
  const col = isPhotoCollage() && act.activeCollage();
  if (col) collageBanner();
  const list = [...media.values()].filter((m) => m.kind === 'image');
  if (!list.length) return;
  body.append(h('div', { class: 'lp-sub' }, col ? '가져온 사진 (누르면 칸에 들어가요)' : '가져온 사진'));
  body.append(h('div', { class: 'media-grid' }, list.map((m) => {
    const card = h('div', { class: 'media-card', dataset: { id: m.id, tip: col ? '누르면 칸에 넣어요 · 칸 위로 끌어다 놓기' : '이 사진 열기' } },
      h('img', { class: 'mc-thumb', src: m.thumbUrl, alt: '', draggable: 'false' }), h('div', { class: 'mc-name' }, m.name));
    dragSource(card, {
      ghost: () => h('img', { src: m.thumbUrl, alt: '' }),
      onClick: () => (col ? act.fillFromMedia(m) : openPhoto(m)),
      onMove: (x, y) => flashCell(collageCellAtClient(x, y)),
      onDrop: (x, y) => { flashCell(null); const cell = collageCellAtClient(x, y); if (cell) act.fillCell(cell.f, cell.idx, m); },
    });
    return card;
  })));
}

// 분할 화면을 고른 상태면: 미디어를 누르면 칸에 들어간다는 안내
function collageBanner() {
  const f = act.activeCollage();
  if (!f) return;
  const sc = act.selectedCell();
  const n = cellCount(f.clip);
  body.append(h('div', { class: 'cell-banner' },
    icon('layout', 16),
    h('span', null, sc ? `${sc.idx + 1}번 칸을 골랐어요. 아래 사진·영상을 누르면 그 칸에 들어가요.` : `분할 화면(${n}칸)을 골랐어요. 누르면 빈 칸부터 채워요.`),
    store.mode === 'photo' ? null : h('button', { class: 'pbtn sm', onclick: () => { act.selectCell(null); store.select(null); } }, '그만 채우기')));
}

// 분할(콜라주) 탭
function collageTab() {
  const photo = store.mode === 'photo';
  const f = act.activeCollage();
  body.append(h('p', { class: 'empty-note' }, photo
    ? '레이아웃을 누르면 콜라주가 만들어져요. 이미 만들고 있으면 레이아웃만 바뀌고 넣은 사진은 그대로예요.'
    : '레이아웃을 누르면 재생헤드 위치에 5초짜리 분할 화면이 생겨요. (메인 트랙이 비었으면 메인에, 아니면 위 오버레이 트랙에)'));
  if (f) {
    body.append(h('button', { class: 'wide-btn accent', id: 'btn-fill-many', onclick: () => openFillMany(f), dataset: { tip: '사진·영상을 여러 개 골라 순서대로 칸에 넣어요' } }, icon('layers', 16), '여러 장 한 번에 채우기'));
    collageBanner();
  }
  const grid = h('div', { class: 'layout-grid' });
  let W = 9, H = 16;
  if (photo && store.photo) { W = store.photo.w || 1; H = store.photo.h || 1; }
  else { const a = { '9:16': [9, 16], '16:9': [16, 9], '1:1': [1, 1], '4:5': [4, 5], '3:4': [3, 4] }[store.video.aspect] || [9, 16]; W = a[0]; H = a[1]; }
  if (photo && !f) { W = 1; H = 1; }
  const th = 90, tw = Math.max(40, Math.min(150, Math.round(th * W / H)));
  for (const L of LAYOUTS) {
    const cv = h('canvas', { width: String(tw), height: String(th) });
    drawLayoutThumb(cv, L.id);
    const on = f && f.clip.collage.layout === L.id;
    grid.append(h('button', { class: 'layout-tile' + (on ? ' on' : ''), dataset: { id: L.id, tip: L.name + (photo && f ? '(으)로 바꾸기' : ' 넣기') }, onclick: () => act.addCollage(L.id) }, cv, h('span', null, L.name)));
  }
  body.append(grid);
  if (!photo && f) body.append(h('p', { class: 'empty-note' }, '고른 분할 클립의 레이아웃을 바꾸려면 오른쪽 "분할" 탭을 쓰세요. (여기서 누르면 새로 하나 더 생겨요)'));
}

// 여러 장 한 번에 채우기 창
export function openFillMany(f) {
  const photo = store.mode === 'photo';
  const list = [...media.values()].filter((m) => (photo ? m.kind === 'image' : m.kind !== 'audio'));
  const n = cellCount(f.clip);
  const picked = [];
  const grid = h('div', { class: 'media-grid pick-grid' });
  const go = h('button', { class: 'pbtn primary', id: 'fill-go' }, '넣기');
  const draw = () => {
    grid.replaceChildren(...list.map((m) => {
      const k = picked.indexOf(m);
      return h('button', { class: 'media-card pick' + (k >= 0 ? ' on' : ''), dataset: { id: m.id }, onclick: () => { const i = picked.indexOf(m); if (i >= 0) picked.splice(i, 1); else picked.push(m); draw(); } },
        h('img', { class: 'mc-thumb', src: m.thumbUrl || '', alt: '' }),
        k >= 0 ? h('span', { class: 'pick-no' }, String(k + 1)) : null,
        m.kind === 'video' ? h('span', { class: 'mc-kind' }, icon('video', 12)) : null,
        h('div', { class: 'mc-name' }, m.name));
    }));
    go.textContent = picked.length ? `${Math.min(picked.length, n)}개 순서대로 넣기` : '넣기';
    go.disabled = !picked.length;
  };
  const fin = h('input', { type: 'file', multiple: true, accept: photo ? ACCEPT_IMAGE : ACCEPT_IMAGE + ',.mp4,.webm,.mov,video/mp4,video/webm,video/quicktime', hidden: true });
  fin.addEventListener('change', async () => {
    const files = [...fin.files]; fin.value = '';
    if (!files.length) return;
    const got = [];
    for (const file of files.slice(0, 12)) {
      try { const m = await importFile(file); if (m.kind !== 'audio') got.push(m); } catch (e) { toast(`못 가져왔어요: ${file.name.slice(0, 30)} — ${e.message}`, { type: 'err', ms: 4000 }); }
    }
    store.emit('media');
    if (got.length) { close(); act.fillMany(f, got); }
  });
  const close = () => dlg.remove();
  go.addEventListener('click', () => { close(); act.fillMany(f, picked); });
  const dlg = h('div', { class: 'modal-back', onclick: (e) => { if (e.target === dlg) close(); } },
    h('div', { class: 'modal fill-modal', role: 'dialog', 'aria-label': '여러 장 한 번에 채우기' },
      h('div', { class: 'modal-head' }, h('b', null, `여러 장 한 번에 채우기 (${n}칸)`), h('button', { class: 'ibtn', onclick: close, 'aria-label': '닫기' }, icon('close'))),
      h('p', { class: 'note' }, '누른 순서대로 1번 칸부터 들어가요. 숫자가 그 순서예요.'),
      list.length ? grid : h('p', { class: 'empty-note' }, '아직 가져온 사진이 없어요. 아래 "파일에서 고르기"를 누르세요.'),
      fin,
      h('div', { class: 'modal-foot' },
        h('button', { class: 'pbtn', onclick: () => fin.click() }, icon('folder', 16), '파일에서 고르기'),
        h('button', { class: 'pbtn', onclick: close }, '취소'),
        go)));
  draw();
  document.body.append(dlg);
}

function textTab() {
  body.append(h('button', { class: 'import-box small', onclick: () => act.addText('basic'), dataset: { tip: '재생헤드 위치에 3초짜리 텍스트를 넣어요' } },
    h('span', { class: 'import-plus' }, 'T'), h('span', { class: 'import-title' }, '기본 텍스트 넣기')));
  body.append(h('div', { class: 'lp-sub' }, '스타일 골라 넣기'));
  const grid = h('div', { class: 'preset-grid' });
  for (const p of TEXT_PRESETS) {
    const cv = h('canvas', { width: '240', height: '120' });
    const tile = h('div', { class: 'preset-tile', dataset: { tip: p.name + ' 넣기' } }, cv, h('span', null, p.name));
    const draw = () => renderTextThumb(cv, presetStyle(p.id).style, '가나다 Aa');
    draw();
    document.fonts?.ready.then(draw);
    dragSource(tile, { ghost: () => h('span', null, p.name), onClick: () => act.addText(p.id), onDrop: (x, y) => { if (tl.hit(x, y) || overPreview(x, y)) act.addText(p.id); } });
    grid.append(tile);
  }
  body.append(grid);
}
function overPreview(x, y) {
  const pv = document.querySelector('.pv-stage')?.getBoundingClientRect();
  return pv && x >= pv.left && x <= pv.right && y >= pv.top && y <= pv.bottom;
}
function stickerTab() {
  for (const g of STICKERS) {
    body.append(h('div', { class: 'lp-sub' }, g.name));
    body.append(h('div', { class: 'sticker-grid' }, g.items.map((e) => {
      const b = h('button', { class: 'sticker-btn', dataset: { tip: '누르면 넣어요' } }, e);
      dragSource(b, { ghost: () => h('span', { class: 'ghost-emoji' }, e), onClick: () => act.addSticker(e), onDrop: (x, y) => { if (tl.hit(x, y) || overPreview(x, y)) act.addSticker(e); } });
      return b;
    })));
  }
}
function transTab() {
  body.append(h('p', { class: 'empty-note' }, '메인 트랙 두 클립 사이 경계로 끌어다 놓거나, 눌러서 고른 경계(또는 재생헤드에 가까운 경계)에 넣어요.'));
  const grid = h('div', { class: 'trans-grid' });
  for (const t of TRANSITIONS) {
    const tile = h('div', { class: 'trans-tile', dataset: { id: t.id, tip: t.name + ' 넣기' } },
      h('div', { class: 'tp tp-' + t.id }, h('i', { class: 'a' }), h('i', { class: 'b' })), h('span', null, t.name));
    dragSource(tile, {
      ghost: () => h('span', null, t.name),
      onClick: () => act.applyTransitionSmart(t.id),
      onDrop: (x, y) => {
        const hit = tl.hit(x, y);
        if (!hit) return;
        const bds = mainBoundaries(store.p);
        if (!bds.length) { toast('메인 트랙에 붙어 있는 클립이 두 개 이상 있어야 해요'); return; }
        const near = bds.reduce((a, b) => (Math.abs(b.t - hit.time) < Math.abs(a.t - hit.time) ? b : a));
        if (Math.abs(near.t - hit.time) * tl.pps > 60) { toast('클립 사이 경계 가까이에 놓아 주세요'); return; }
        act.setTransition(near.a.id, t.id);
      },
    });
    grid.append(tile);
  }
  body.append(grid);
}
function filterTab() {
  const f = act.visualTarget();
  const m = f ? media.get(f.clip.mediaId) : null;
  const img = m ? (m.kind === 'image' ? m.bitmap : m.thumbImgs?.[Math.floor((m.thumbImgs.length - 1) / 2)]) : null;
  body.append(h('p', { class: 'empty-note' }, f ? '눌러서 고른 클립에 넣어요. 강도는 오른쪽 "필터" 탭에서 조절해요.' : '먼저 사진·영상 클립을 고르세요.'));
  body.append(filterGrid(img, f?.clip.filter?.id));
}
export function filterGrid(img, curId) {
  const sample = img || sampleImage();
  const grid = h('div', { class: 'filter-grid' });
  for (const fl of FILTERS) {
    const cv = h('canvas', { width: '120', height: '120' });
    renderFilterThumb(cv, sample, effectiveFx({ adj: {}, filter: { id: fl.id, strength: 1 } }));
    grid.append(h('button', { class: 'filter-tile' + (curId === fl.id ? ' on' : ''), dataset: { id: fl.id, tip: fl.name }, onclick: () => act.applyFilter(fl.id) }, cv, h('span', null, fl.name)));
  }
  return grid;
}
let sampleCv = null;
function sampleImage() {
  if (sampleCv) return sampleCv;
  sampleCv = document.createElement('canvas'); sampleCv.width = 160; sampleCv.height = 160;
  const x = sampleCv.getContext('2d');
  const g = x.createLinearGradient(0, 0, 0, 160); g.addColorStop(0, '#6ec3ff'); g.addColorStop(0.6, '#ffd59e'); g.addColorStop(1, '#3a8f4b');
  x.fillStyle = g; x.fillRect(0, 0, 160, 160);
  x.fillStyle = '#ff9f43'; x.beginPath(); x.arc(110, 60, 22, 0, Math.PI * 2); x.fill();
  x.fillStyle = '#2d6a3a'; x.beginPath(); x.moveTo(0, 130); x.lineTo(60, 90); x.lineTo(120, 130); x.lineTo(160, 110); x.lineTo(160, 160); x.lineTo(0, 160); x.fill();
  return sampleCv;
}
export { findClip, mainTrack, clipEnd, fmtBytes };
