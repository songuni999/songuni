// 오른쪽 속성 패널
import { store } from './store.js';
import { h, clamp, toast, cleanText, MAX_TEXT, MAX_NAME, fmtDur } from './util.js';
import { icon } from './icons.js';
import { media } from './media.js';
import { canvasSize, ASPECTS, ASPECT_NAMES, fixOverlap, packMain, mainTrack, findClip, clipEnd, maxDur, defaultAdj, transDur } from './model.js';
import { ADJ_KEYS, FONTS, TEXT_PRESETS, presetStyle, ANIMS, ANIM_OUT_NAME, TRANSITIONS, FILTER_MAP } from './effects.js';
import * as act from './actions.js';
import { filterGrid, openFillMany } from './panels.js';
import { openCrop, setCropRatio, rotate90, COLLAGE_RATIOS, setCollageRatio } from './photo.js';
import { LAYOUTS, drawLayoutThumb, cellCount, layoutOf } from './collage.js';
import { openTextEditor } from './preview.js';

let root, head, body;
const lastTab = {};

export function initProps(el) {
  root = el;
  head = h('div', { class: 'rp-head' });
  body = h('div', { class: 'rp-body' });
  root.append(head, body);
  store.on('select', render);
  store.on('project', render);
  store.on('mode', render);
  store.on('cellsel', render);
  render();
}

// 폰 배치: 아래 도구줄에서 고른 탭을 바로 띄운다
export function setPropTab(key, tab) { lastTab[key] = tab; render(); }
export function propTabKey() {
  const f = store.selected();
  if (f) return f.clip.type;
  if (store.mode === 'photo') { const tr = store.p && mainTrack(store.p); return tr && tr.clips[0] && tr.clips[0].type === 'collage' ? 'photoCol' : 'photo'; }
  return null;
}

// ── 공용 조작 부품 ──
const commit = () => store.commit();
const live = () => { store.emit('render'); };
function row(label, ...ctrl) { return h('div', { class: 'prow' }, h('label', { class: 'plabel' }, label), h('div', { class: 'pctrl' }, ctrl)); }
function slider({ label, min, max, step = 1, get, set, def = 0, fmt = (v) => String(Math.round(v)), center = false, unit = '' }) {
  const v0 = get();
  const rng = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(v0), class: 'rng' + (center ? ' center' : ''), 'aria-label': label, dataset: { tip: '더블클릭하면 처음 값으로' } });
  const num = h('input', { type: 'number', min: String(min), max: String(max), step: String(step), value: fmt(v0), class: 'num', 'aria-label': label });
  const paint = (v) => {
    const pct = (v - min) / (max - min) * 100;
    const c0 = center ? (0 - min) / (max - min) * 100 : 0;
    rng.style.setProperty('--a', Math.min(pct, c0) + '%');
    rng.style.setProperty('--b', Math.max(pct, c0) + '%');
  };
  paint(v0);
  rng.addEventListener('input', () => { const v = +rng.value; set(v); num.value = fmt(v); paint(v); live(); });
  rng.addEventListener('change', commit);
  rng.addEventListener('dblclick', () => { set(def); rng.value = String(def); num.value = fmt(def); paint(def); live(); commit(); });
  num.addEventListener('change', () => { const v = clamp(+num.value || 0, min, max); set(v); rng.value = String(v); num.value = fmt(v); paint(v); live(); commit(); });
  return h('div', { class: 'prow' }, h('label', { class: 'plabel' }, label), h('div', { class: 'pctrl slider' }, rng, num, unit ? h('span', { class: 'unit' }, unit) : null));
}
function seg(options, cur, onPick) {
  return h('div', { class: 'seg' }, options.map(([v, label]) => h('button', { class: 'seg-btn' + (v === cur ? ' on' : ''), onclick: () => onPick(v) }, label)));
}
function color(get, set) {
  const inp = h('input', { type: 'color', value: get(), class: 'color' });
  inp.addEventListener('input', () => { set(inp.value); live(); });
  inp.addEventListener('change', commit);
  return inp;
}
function toggle(label, get, set) {
  const cb = h('input', { type: 'checkbox', checked: get() });
  cb.addEventListener('change', () => { set(cb.checked); commit(); });
  return h('label', { class: 'toggle' }, cb, h('span', { class: 'tg' }), h('span', null, label));
}
function btn(ic, label, fn, cls = '') { return h('button', { class: 'pbtn ' + cls, onclick: fn }, ic ? icon(ic, 16) : null, label); }
function section(title, ...kids) { return h('div', { class: 'psec' }, title ? h('div', { class: 'psec-title' }, title) : null, kids); }

function tabs(list, key) {
  let cur = lastTab[key];
  if (!list.some((t) => t[0] === cur)) cur = list[0][0];
  const bar = h('div', { class: 'rp-tabs' }, list.map(([id, name]) => h('button', { class: 'rp-tab' + (id === cur ? ' on' : ''), dataset: { tab: id }, onclick: () => { lastTab[key] = id; render(); } }, name)));
  head.append(bar);
  return cur;
}

// ── 화면 그리기 ──
function render() {
  if (!root) return;
  const sy = body.scrollTop;
  head.replaceChildren(); body.replaceChildren();
  const p = store.p;
  if (!p) return;
  if (store.selTrans) { transPanel(); return; }
  let f = store.selected();
  if (!f && store.mode === 'photo') {
    const tr = mainTrack(p);
    if (tr.clips[0]) f = findClip(p, tr.clips[0].id);
    if (f) { photoPanel(f); body.scrollTop = sy; return; }
  }
  if (!f) { projectPanel(); return; }
  const c = f.clip, isMain = f.track.kind === 'main';
  const title = { video: '영상', image: '사진', text: '텍스트', sticker: '스티커', audio: '오디오', collage: '분할 화면' }[c.type];
  head.append(h('div', { class: 'rp-title' }, icon({ video: 'video', image: 'image', text: 'text', sticker: 'sticker', audio: 'music', collage: 'layout' }[c.type], 18), h('span', null, title + ' 편집'),
    h('button', { class: 'ibtn sm', dataset: { tip: '선택 해제', key: 'Esc' }, onclick: () => store.select(null) }, icon('close', 16))));
  if (f.track.locked) body.append(h('div', { class: 'warn-note' }, icon('lock', 14), '잠긴 트랙이에요. 타임라인 왼쪽 자물쇠를 눌러 풀어야 고칠 수 있어요.'));
  let list;
  if (c.type === 'video') list = [['basic', '기본'], ['crop', '자르기'], ['speed', '속도'], ['audio', '오디오'], ['filter', '필터'], ['adjust', '조정'], ['anim', '애니메이션']];
  else if (c.type === 'image') list = [['basic', '기본'], ['crop', '자르기'], ['filter', '필터'], ['adjust', '조정'], ['anim', '애니메이션']];
  else if (c.type === 'text') list = [['text', '텍스트'], ['basic', '기본'], ['anim', '애니메이션']];
  else if (c.type === 'sticker') list = [['basic', '기본'], ['anim', '애니메이션']];
  else if (c.type === 'collage') list = [['collage', '분할'], ['basic', '기본'], ['audio', '오디오'], ['filter', '필터'], ['adjust', '조정'], ['anim', '애니메이션']];
  else list = [['audio', '오디오'], ['speed', '속도']];
  if (isMain && store.mode !== 'photo') list.push(['bg', '배경']);
  const tab = tabs(list, c.type);
  const wrap = h('div', { class: 'rp-content' + (f.track.locked ? ' disabled' : '') });
  body.append(wrap);
  ({ basic: basicTab, crop: cropTab, speed: speedTab, audio: audioTab, filter: filterTab, adjust: adjustTab, anim: animTab, bg: bgTab, text: textTab, collage: collageTab }[tab])(wrap, c, f);
  body.scrollTop = sy;
}

function basicTab(w, c) {
  const { W, H } = canvasSize(store.p);
  const tf = c.tf;
  w.append(section('위치·크기',
    slider({ label: '가로 위치', min: -W, max: W, get: () => Math.round((tf.x - 0.5) * W), set: (v) => { tf.x = 0.5 + v / W; }, def: 0, center: true }),
    slider({ label: '세로 위치', min: -H, max: H, get: () => Math.round((tf.y - 0.5) * H), set: (v) => { tf.y = 0.5 + v / H; }, def: 0, center: true }),
    slider({ label: '크기', min: 5, max: 500, get: () => Math.round(tf.scale * 100), set: (v) => { tf.scale = v / 100; }, def: 100, unit: '%' }),
    slider({ label: '회전', min: -180, max: 180, get: () => Math.round(tf.rot || 0), set: (v) => { tf.rot = v; }, def: 0, center: true, unit: '°' }),
    slider({ label: '불투명도', min: 0, max: 100, get: () => Math.round(tf.opacity * 100), set: (v) => { tf.opacity = v / 100; }, def: 100, unit: '%' })));
  w.append(section('뒤집기·맞춤',
    h('div', { class: 'btn-row' },
      btn('flipH', '좌우 뒤집기', () => { tf.flipH = !tf.flipH; store.commit('좌우로 뒤집었어요'); }, tf.flipH ? 'on' : ''),
      btn('flipV', '상하 뒤집기', () => { tf.flipV = !tf.flipV; store.commit('상하로 뒤집었어요'); }, tf.flipV ? 'on' : '')),
    c.type === 'video' || c.type === 'image' ? row('화면 맞춤', seg([['fit', '맞춤(전체 보이기)'], ['fill', '채움(꽉 채우기)']], c.fit, (v) => { c.fit = v; store.commit(v === 'fill' ? '화면을 꽉 채웠어요' : '전체가 보이게 맞췄어요'); })) : null,
    btn('reset', '위치·크기 처음으로', () => { Object.assign(tf, { x: c.type === 'text' ? tf.x : 0.5, y: c.type === 'text' ? tf.y : 0.5, scale: 1, rot: 0, opacity: 1, flipH: false, flipV: false }); if (c.type !== 'text') { tf.x = 0.5; tf.y = 0.5; } store.commit('처음 상태로 돌렸어요'); })));
  if (store.mode !== 'photo') w.append(section('클립', h('div', { class: 'btn-row' },
    btn('dup', '복제', () => act.duplicate()), btn('split', '분할', () => act.split()), btn('trash', '삭제', () => act.del(), 'danger'))));
}
function cropTab(w, c) {
  const ratios = [['free', '자유'], ['orig', '원본'], ['1:1', '1:1'], ['9:16', '9:16'], ['16:9', '16:9'], ['4:5', '4:5'], ['3:4', '3:4']];
  w.append(section('자르기 비율', h('div', { class: 'chip-grid' }, ratios.map(([v, n]) => h('button', { class: 'chip' + (c.cropRatio === v ? ' on' : ''), onclick: () => setCropRatio(c, v) }, n))),
    h('div', { class: 'btn-row' }, btn('crop', '직접 자르기(화면에서)', () => openCrop(c), 'primary'), btn('reset', '자르기 없애기', () => { c.crop = { x: 0, y: 0, w: 1, h: 1 }; c.cropRatio = 'free'; store.commit('자르기를 없앴어요'); }))));
  w.append(section('90도 회전', h('div', { class: 'btn-row' }, btn('rotL', '왼쪽으로', () => rotate90(c, -90)), btn('rotR', '오른쪽으로', () => rotate90(c, 90)))));
}
function speedTab(w, c) {
  const srcLen = c.dur * c.speed;
  const apply = (v) => {
    const s0 = c.speed;
    const sl = c.dur * s0;
    c.speed = Math.round(v * 100) / 100;
    c.dur = Math.max(1 / 30, sl / c.speed);
    const md = maxDur(c);
    if (isFinite(md) && c.dur > md) c.dur = md;
  };
  w.append(section('속도', h('div', { class: 'chip-grid' }, [0.25, 0.5, 1, 1.5, 2, 3, 4].map((v) => h('button', { class: 'chip' + (Math.abs(c.speed - v) < 1e-3 ? ' on' : ''), onclick: () => { apply(v); fixOverlap(store.p, c); store.commit(`속도를 ${v}배로 바꿨어요`); } }, v + '배'))),
    slider({ label: '직접 조절', min: 0.25, max: 4, step: 0.05, get: () => c.speed, set: (v) => apply(v), def: 1, fmt: (v) => (+v).toFixed(2), unit: '배' }),
    h('p', { class: 'note' }, `원본 ${fmtDur(srcLen)} → 지금 ${fmtDur(c.dur)}`)));
  // 슬라이더 놓을 때 겹침 정리
  w.querySelector('.rng')?.addEventListener('change', () => { fixOverlap(store.p, c); store.commit(); });
}
function audioTab(w, c, f) {
  const fmax = Math.max(0.1, Math.min(10, c.dur / 2));
  w.append(section('소리',
    slider({ label: '볼륨', min: 0, max: 200, get: () => Math.round((c.volume ?? 1) * 100), set: (v) => { c.volume = v / 100; }, def: 100, unit: '%' }),
    slider({ label: '페이드 인', min: 0, max: fmax, step: 0.1, get: () => c.fadeIn || 0, set: (v) => { c.fadeIn = v; }, def: 0, fmt: (v) => (+v).toFixed(1), unit: '초' }),
    slider({ label: '페이드 아웃', min: 0, max: fmax, step: 0.1, get: () => c.fadeOut || 0, set: (v) => { c.fadeOut = v; }, def: 0, fmt: (v) => (+v).toFixed(1), unit: '초' })));
  if (c.type === 'collage') {
    w.append(section(null, toggle('분할 화면 소리 모두 끄기', () => !!c.muted, (v) => { c.muted = v; }),
      h('p', { class: 'note' }, '칸마다 소리를 끄려면 "분할" 탭의 칸 목록에서 스피커 버튼을 누르세요.')));
  } else if (c.type === 'video') {
    const m = media.get(c.mediaId);
    w.append(section('원본 소리',
      toggle('원본 소리 끄기', () => !!c.muted, (v) => { c.muted = v; }),
      m && m.hasAudio ? btn('detach', '소리 분리(오디오 트랙으로)', () => act.detachAudio(c.id)) : h('p', { class: 'note' }, '이 영상에는 소리가 없어요.')));
  } else {
    w.append(section(null, toggle('소리 끄기', () => !!c.muted, (v) => { c.muted = v; })));
  }
}
function filterTab(w, c) {
  const m = media.get(c.mediaId);
  const img = m ? (m.kind === 'image' ? m.bitmap : m.thumbImgs?.[Math.floor((m.thumbImgs.length - 1) / 2)]) : null;
  w.append(section('필터', filterGrid(img, c.filter?.id || 'none')));
  if (c.filter && c.filter.id !== 'none') {
    w.append(section(`강도 (${FILTER_MAP[c.filter.id]?.name})`, slider({ label: '강도', min: 0, max: 100, get: () => Math.round((c.filter.strength ?? 1) * 100), set: (v) => { c.filter.strength = v / 100; }, def: 100, unit: '%' })));
  }
  w.append(compareBtn());
}
function compareBtn() {
  const b = h('button', { class: 'pbtn compare', dataset: { tip: '누르고 있는 동안 원본을 보여 줘요' } }, icon('compare', 16), '원본 비교 (누르고 있기)');
  const on = (e) => { e.preventDefault(); store.compare = true; store.emit('render'); b.classList.add('on'); };
  const off = () => { if (!store.compare) return; store.compare = false; store.emit('render'); b.classList.remove('on'); };
  b.addEventListener('pointerdown', on); b.addEventListener('pointerup', off); b.addEventListener('pointerleave', off); b.addEventListener('pointercancel', off);
  return b;
}
function adjustTab(w, c) {
  c.adj ||= defaultAdj();
  w.append(section('조정 (가운데가 0, 더블클릭하면 0)', ADJ_KEYS.map(([k, name]) => slider({ label: name, min: -100, max: 100, get: () => c.adj[k] || 0, set: (v) => { c.adj[k] = v; }, def: 0, center: true }))));
  w.append(h('div', { class: 'btn-row' }, compareBtn(), btn('reset', '전체 초기화', () => { c.adj = defaultAdj(); store.commit('조정을 처음으로 돌렸어요'); })));
}
function animTab(w, c) {
  const key = 'animSide';
  const side = lastTab[key] || 'in';
  w.append(seg([['in', '들어올 때'], ['out', '나갈 때']], side, (v) => { lastTab[key] = v; render(); }));
  const a = c.anim[side];
  const list = ANIMS.filter((x) => !x.textOnly || c.type === 'text');
  w.append(h('div', { class: 'anim-grid' }, list.map((x) => h('button', {
    class: 'anim-tile' + (a.type === x.id ? ' on' : ''),
    onclick: () => { a.type = x.id; if (x.id !== 'none' && a.dur > c.dur) a.dur = Math.min(0.5, c.dur / 2); store.commit(x.id === 'none' ? '애니메이션을 뺐어요' : `'${side === 'out' ? ANIM_OUT_NAME[x.id] || x.name : x.name}' 애니메이션을 넣었어요`); store.setTime(side === 'in' ? c.start : Math.max(c.start, clipEnd(c) - a.dur - 0.05)); },
  }, h('span', { class: 'anim-ic a-' + x.id }), side === 'out' ? ANIM_OUT_NAME[x.id] || x.name : x.name))));
  if (a.type !== 'none') w.append(slider({ label: '길이', min: 0.1, max: Math.max(0.2, Math.min(5, c.dur)), step: 0.1, get: () => a.dur, set: (v) => { a.dur = v; }, def: 0.5, fmt: (v) => (+v).toFixed(1), unit: '초' }));
  w.append(btn('play', '애니메이션 미리 보기', () => { store.setTime(side === 'in' ? c.start : Math.max(c.start, clipEnd(c) - a.dur - 0.3)); import('./preview.js').then((m) => m.getPlayer().play()); }));
}
function bgTab(w, c) {
  c.bg ||= { type: 'none', color: '#000000' };
  const swatches = ['#000000', '#ffffff', '#1a1a1f', '#ff4d6d', '#ffb703', '#00d4c8', '#3a86ff', '#8338ec', '#2a9d8f', '#f4a261'];
  w.append(section('빈 곳 채우기', seg([['none', '없음'], ['color', '색 채우기'], ['blur', '흐림 채우기']], c.bg.type, (v) => { c.bg.type = v; store.commit(v === 'blur' ? '흐림 배경을 넣었어요' : v === 'color' ? '색 배경을 넣었어요' : '배경을 뺐어요'); })));
  if (c.bg.type === 'color') {
    w.append(section('색', h('div', { class: 'swatches' }, swatches.map((s) => h('button', { class: 'swatch' + (c.bg.color === s ? ' on' : ''), style: { background: s }, 'aria-label': s, onclick: () => { c.bg.color = s; store.commit(); } })), color(() => c.bg.color || '#000000', (v) => { c.bg.color = v; }))));
  }
  w.append(h('p', { class: 'note' }, '사진·영상이 화면보다 작을 때 남는 곳을 채워요. (화면 맞춤이 "맞춤"일 때 보여요)'));
  w.append(btn('layers', '메인 트랙 모든 클립에 적용', () => { for (const x of mainTrack(store.p).clips) x.bg = { ...c.bg }; store.commit('모든 클립에 같은 배경을 넣었어요'); }));
}
function textTab(w, c) {
  const st = c.text;
  const ta = h('textarea', { class: 'ptext', maxlength: String(MAX_TEXT), rows: '3', 'aria-label': '글 내용', placeholder: '글을 입력하세요' });
  ta.value = st.content;
  ta.addEventListener('input', () => { st.content = cleanText(ta.value, MAX_TEXT); live(); });
  ta.addEventListener('change', () => commit());
  w.append(section('글 내용 (최대 500자)', ta, h('div', { class: 'btn-row' }, btn('edit', '미리보기에서 고치기', () => openTextEditor(c.id)))));
  w.append(section('스타일', h('div', { class: 'chip-grid' }, TEXT_PRESETS.map((p) => h('button', { class: 'chip' + (st.preset === p.id ? ' on' : ''), onclick: () => {
    const { style } = presetStyle(p.id);
    const k = Math.min(...Object.values(canvasSize(store.p))) / 1080;
    Object.assign(st, style, { size: Math.round(style.size * k), strokeW: Math.round(style.strokeW * k), content: st.content });
    store.commit(`'${p.name}' 스타일을 넣었어요`);
  } }, p.name)))));
  const fontSel = h('select', { class: 'sel', 'aria-label': '글꼴' }, FONTS.map((f) => h('option', { value: f.id, style: { fontFamily: f.id } }, f.name)));
  fontSel.value = st.font;
  fontSel.addEventListener('change', () => { st.font = fontSel.value; document.fonts?.load(`40px "${st.font}"`).then(() => store.emit('render')); commit(); });
  w.append(section('글꼴',
    row('글꼴', fontSel),
    slider({ label: '크기', min: 12, max: 400, get: () => st.size, set: (v) => { st.size = v; }, def: 80, unit: 'px' }),
    row('글자색', color(() => st.color, (v) => { st.color = v; })),
    h('div', { class: 'btn-row' },
      btn(null, '굵게', () => { st.bold = !st.bold; commit(); }, st.bold ? 'on' : ''),
      btn(null, '기울임', () => { st.italic = !st.italic; commit(); }, st.italic ? 'on' : '')),
    row('정렬', seg([['left', '왼쪽'], ['center', '가운데'], ['right', '오른쪽']], st.align, (v) => { st.align = v; commit(); })),
    slider({ label: '줄 간격', min: 0.8, max: 2.5, step: 0.05, get: () => st.lineH, set: (v) => { st.lineH = v; }, def: 1.25, fmt: (v) => (+v).toFixed(2) })));
  w.append(section('테두리',
    slider({ label: '두께', min: 0, max: 40, get: () => st.strokeW, set: (v) => { st.strokeW = v; }, def: 0 }),
    row('테두리색', color(() => st.stroke, (v) => { st.stroke = v; }))));
  w.append(section('그림자', toggle('그림자 넣기', () => !!st.shadow, (v) => { st.shadow = v; }),
    st.shadow ? row('그림자색', color(() => (st.shadowColor || '#000000').slice(0, 7), (v) => { st.shadowColor = v; })) : null,
    st.shadow ? slider({ label: '흐림', min: 0, max: 60, get: () => st.shadowBlur ?? 10, set: (v) => { st.shadowBlur = v; }, def: 10 }) : null));
  w.append(section('배경 박스', toggle('글 뒤에 박스', () => !!st.box, (v) => { st.box = v; }),
    st.box ? row('박스색', color(() => st.boxColor, (v) => { st.boxColor = v; })) : null,
    st.box ? slider({ label: '박스 진하기', min: 0, max: 100, get: () => Math.round((st.boxOpacity ?? 0.8) * 100), set: (v) => { st.boxOpacity = v / 100; }, def: 80, unit: '%' }) : null));
}
function transPanel() {
  const f = findClip(store.p, store.selTrans);
  if (!f || !f.clip.transition) { store.selTrans = null; projectPanel(); return; }
  const tr = f.clip.transition;
  const next = mainTrack(store.p).clips.find((x) => Math.abs(x.start - clipEnd(f.clip)) < 1e-3);
  head.append(h('div', { class: 'rp-title' }, icon('trans', 18), h('span', null, '전환 편집'),
    h('button', { class: 'ibtn sm', dataset: { tip: '닫기' }, onclick: () => store.select(null) }, icon('close', 16))));
  const w = h('div', { class: 'rp-content' });
  body.append(w);
  w.append(section('전환 종류', h('div', { class: 'chip-grid' }, TRANSITIONS.map((t) => h('button', { class: 'chip' + (tr.type === t.id ? ' on' : ''), onclick: () => { tr.type = t.id; store.commit(); } }, t.name)))));
  const maxD = next ? Math.max(0.2, Math.min(3, f.clip.dur, next.dur)) : 2;
  w.append(section('길이', slider({ label: '길이', min: 0.1, max: maxD, step: 0.1, get: () => tr.dur, set: (v) => { tr.dur = v; }, def: 0.6, fmt: (v) => (+v).toFixed(1), unit: '초' })));
  w.append(h('div', { class: 'btn-row' },
    btn('play', '미리 보기', () => { const d = next ? transDur(f.clip, next) : tr.dur; store.setTime(Math.max(0, clipEnd(f.clip) - d / 2 - 0.5)); import('./preview.js').then((m) => m.getPlayer().play()); }),
    btn('layers', '모든 경계에 적용', () => act.applyTransitionAll(tr.type, tr.dur)),
    btn('trash', '전환 지우기', () => act.removeTransition(f.clip.id), 'danger')));
}
function photoPanel(f) {
  const c = f.clip;
  const col = c.type === 'collage';
  head.append(h('div', { class: 'rp-title' }, icon(col ? 'layout' : 'image', 18), h('span', null, col ? '콜라주 꾸미기' : '사진 꾸미기')));
  const tab = col ? tabs([['collage', '콜라주'], ['adjust', '조정'], ['filter', '필터']], 'photoCol') : tabs([['adjust', '조정'], ['filter', '필터'], ['crop', '자르기']], 'photo');
  const w = h('div', { class: 'rp-content' });
  body.append(w);
  ({ adjust: adjustTab, filter: filterTab, crop: cropTab, collage: collageTab })[tab](w, c, f);
}
function projectPanel() {
  const p = store.p;
  head.append(h('div', { class: 'rp-title' }, icon('gear', 18), h('span', null, store.mode === 'photo' ? '사진 설정' : '프로젝트 설정')));
  const w = h('div', { class: 'rp-content' });
  body.append(w);
  if (store.mode === 'photo') { w.append(h('p', { class: 'note' }, '왼쪽 "사진" 탭에서 사진을 열어 주세요.')); return; }
  const name = h('input', { type: 'text', class: 'tinput', maxlength: String(MAX_NAME), value: p.name, 'aria-label': '프로젝트 이름' });
  name.addEventListener('change', () => { p.name = cleanText(name.value, MAX_NAME).trim() || '제목 없는 프로젝트'; store.commit(); store.emit('name'); });
  w.append(section('이름', name));
  w.append(section('화면비', h('div', { class: 'aspect-grid' }, Object.keys(ASPECTS).map((a) => {
    const [aw, ah] = ASPECTS[a]; const s = 34 / Math.max(aw, ah);
    return h('button', { class: 'aspect-btn' + (p.aspect === a ? ' on' : ''), dataset: { tip: ASPECT_NAMES[a] }, onclick: () => setAspect(a) },
      h('i', { style: { width: aw * s + 'px', height: ah * s + 'px' } }), h('span', null, a));
  }))));
  w.append(section('배경색', row('빈 곳 색', color(() => p.bg, (v) => { p.bg = v; }))));
  w.append(section('새 클립 배치', seg([['fit', '맞춤(전체 보이기)'], ['fill', '채움(꽉 채우기)']], p.fitMode, (v) => { p.fitMode = v; store.commit(v === 'fill' ? '앞으로 넣는 클립은 화면을 꽉 채워요' : '앞으로 넣는 클립은 전체가 보이게 맞춰요'); }),
    btn('layers', '지금 있는 클립 모두에 적용', () => { for (const tr of p.tracks) for (const c of tr.clips) if (c.fit) c.fit = p.fitMode; store.commit('모든 클립에 적용했어요'); })));
  w.append(section('내보내기 해상도', seg([[720, '720p'], [1080, '1080p']], p.exportRes, (v) => { p.exportRes = v; store.commit(); })));
  let clips = 0; for (const tr of p.tracks) clips += tr.clips.length;
  w.append(h('p', { class: 'note' }, `클립 ${clips}개 · 전체 길이 ${fmtDur(store.duration())} · 자동 저장됨(이 브라우저 안)`));
  w.append(h('p', { class: 'note' }, document.body.classList.contains('m') ? '도움말: 타임라인의 클립을 톡 누르면 아래 도구가 그 클립용으로 바뀌어요.' : '도움말: 클립을 누르면 여기서 고칠 수 있어요. 단축키는 위쪽 ? 버튼.'));
}
// 분할 화면(콜라주) 탭
function collageTab(w, c, f) {
  const col = c.collage;
  const photo = store.mode === 'photo';
  const n = cellCount(c);
  const cells = col.cells || [];
  // 레이아웃
  const lg = h('div', { class: 'layout-grid small' });
  const { W, H } = canvasSize(store.p);
  const th = 54, tw = Math.max(30, Math.min(96, Math.round(th * W / H)));
  for (const L of LAYOUTS) {
    const cv = h('canvas', { width: String(tw), height: String(th) });
    drawLayoutThumb(cv, L.id, { gap: 3 });
    lg.append(h('button', { class: 'layout-tile' + (col.layout === L.id ? ' on' : ''), dataset: { id: L.id, tip: L.name + '(으)로 바꾸기 (넣은 사진은 그대로)' }, onclick: () => act.setLayout(f, L.id) }, cv));
  }
  w.append(section(`레이아웃 · ${layoutOf(c).name}`, lg));
  if (photo) {
    w.append(section('콜라주 비율', h('div', { class: 'chip-grid' }, Object.keys(COLLAGE_RATIOS).map((k) => h('button', { class: 'chip' + ((store.p.collageRatio || '1:1') === k ? ' on' : ''), onclick: () => setCollageRatio(k) }, k)))));
  }
  // 칸 목록
  const selIdx = store.cellSel && store.cellSel.clipId === c.id ? store.cellSel.idx : -1;
  const rows = [];
  for (let i = 0; i < n; i++) {
    const cell = cells[i] || {};
    const m = cell.mediaId ? media.get(cell.mediaId) : null;
    const pick = () => { store.cellSel = { clipId: c.id, idx: i }; store.emit('cellsel'); };
    rows.push(h('div', { class: 'cell-row' + (i === selIdx ? ' on' : ''), dataset: { idx: String(i) }, onclick: pick },
      h('span', { class: 'cell-no' }, String(i + 1)),
      m ? h('img', { class: 'cell-th', src: m.thumbUrl || '', alt: '' }) : h('span', { class: 'cell-th empty' }, '＋'),
      h('span', { class: 'cell-nm' }, m ? m.name : '비어 있음'),
      h('span', { class: 'cell-acts' },
        h('button', { class: 'ibtn sm', dataset: { tip: '이 칸 바꾸기: 누른 뒤 왼쪽 미디어를 누르세요' }, onclick: (e) => { e.stopPropagation(); pick(); store.emit('openTab', photo ? 'photo' : 'media'); toast(`${i + 1}번 칸: 왼쪽에서 사진·영상을 누르세요`); } }, icon('edit', 14)),
        m && m.kind === 'video' ? h('button', { class: 'ibtn sm' + (cell.muted ? ' on' : ''), dataset: { tip: cell.muted ? '이 칸 소리 켜기' : '이 칸 소리 끄기' }, onclick: (e) => { e.stopPropagation(); cell.muted = !cell.muted; store.commit(cell.muted ? `${i + 1}번 칸 소리를 껐어요` : `${i + 1}번 칸 소리를 켰어요`); } }, icon(cell.muted ? 'mute' : 'vol', 14)) : null,
        m ? h('button', { class: 'ibtn sm', dataset: { tip: '이 칸 비우기' }, onclick: (e) => { e.stopPropagation(); act.clearCell(f, i); } }, icon('trash', 14)) : null)));
  }
  w.append(section('칸 (눌러서 고르기)', h('div', { class: 'cell-list' }, rows),
    h('button', { class: 'pbtn primary', id: 'btn-fill-many-rp', onclick: () => openFillMany(f) }, icon('layers', 16), '여러 장 한 번에 채우기')));
  // 고른 칸 조정
  const sc = selIdx >= 0 ? cells[selIdx] : null;
  if (sc && sc.mediaId && media.has(sc.mediaId)) {
    w.append(section(`${selIdx + 1}번 칸 위치·확대`,
      slider({ label: '확대', min: 100, max: 500, get: () => Math.round((sc.zoom || 1) * 100), set: (v) => { sc.zoom = v / 100; }, def: 100, unit: '%' }),
      slider({ label: '가로 위치', min: -100, max: 100, get: () => Math.round((sc.px || 0) * 100), set: (v) => { sc.px = v / 100; }, def: 0, center: true }),
      slider({ label: '세로 위치', min: -100, max: 100, get: () => Math.round((sc.py || 0) * 100), set: (v) => { sc.py = v / 100; }, def: 0, center: true }),
      h('p', { class: 'note' }, '미리보기에서 칸을 끌면 위치가, 마우스 휠(휴대폰은 두 손가락)로 확대가 바뀌어요. ⇄ 손잡이를 끌어 다른 칸에 놓으면 서로 바뀌어요.'),
      btn('reset', '위치·확대 처음으로', () => { sc.px = 0; sc.py = 0; sc.zoom = 1; store.commit('칸 위치·확대를 처음으로 돌렸어요'); })));
  }
  // 모양
  const sw = ['#ffffff', '#000000', '#1a1a1f', '#f5efe6', '#ff4d6d', '#ffb703', '#00d4c8', '#3a86ff', '#8338ec'];
  w.append(section('모양',
    slider({ label: '칸 간격', min: 0, max: 40, get: () => col.gap || 0, set: (v) => { col.gap = v; }, def: 12, unit: 'px' }),
    slider({ label: '모서리 둥글기', min: 0, max: 80, get: () => col.radius || 0, set: (v) => { col.radius = v; }, def: 0, unit: 'px' }),
    row('테두리·배경 색', color(() => col.color || '#ffffff', (v) => { col.color = v; })),
    h('div', { class: 'swatches' }, sw.map((s) => h('button', { class: 'swatch' + (col.color === s ? ' on' : ''), style: { background: s }, 'aria-label': s, onclick: () => { col.color = s; store.commit('테두리·배경 색을 바꿨어요'); } })))));
}

export function setAspect(a) {
  if (!ASPECTS[a] || store.mode === 'photo') return;
  store.p.aspect = a;
  store.commit(`화면비를 ${a}로 바꿨어요`);
  store.emit('aspect');
}
export { packMain, toast };
