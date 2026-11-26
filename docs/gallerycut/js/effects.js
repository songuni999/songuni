// 필터·조정·텍스트 스타일·스티커·전환·애니메이션 정의
import { clamp, easeOut, backOut } from './util.js';

// 필터 프리셋: 조정 단위(-100~100) + 세피아/흑백(0~100)
export const FILTERS = [
  { id: 'none', name: '원본', p: {} },
  { id: 'clear', name: '선명', p: { contrast: 18, sat: 20, sharp: 45 } },
  { id: 'warm', name: '따뜻하게', p: { temp: 55, sat: 10, bright: 4 } },
  { id: 'cool', name: '차갑게', p: { temp: -55, contrast: 6 } },
  { id: 'vintage', name: '빈티지', p: { sepia: 45, contrast: -12, sat: -20, vignette: 45, bright: 4 } },
  { id: 'mono', name: '흑백', p: { gray: 100, contrast: 15 } },
  { id: 'cinema', name: '영화', p: { contrast: 25, sat: -18, temp: -12, tint: 8, vignette: 35 } },
  { id: 'pastel', name: '파스텔', p: { bright: 14, contrast: -22, sat: -28, tint: 10 } },
  { id: 'sunset', name: '노을', p: { temp: 70, tint: 22, sat: 22, contrast: 8 } },
  { id: 'film', name: '필름', p: { sepia: 20, contrast: 12, sat: -12, vignette: 28, tint: -6 } },
  { id: 'vivid', name: '쨍한', p: { sat: 65, contrast: 20, sharp: 20 } },
  { id: 'noir', name: '누아르', p: { gray: 100, contrast: 55, bright: -10, vignette: 40 } },
  { id: 'dream', name: '몽환', p: { bright: 12, contrast: -15, sat: 10, tint: 18, sharp: -30 } },
  { id: 'fresh', name: '청량', p: { temp: -25, sat: 25, bright: 8, contrast: 8 } },
];
export const FILTER_MAP = Object.fromEntries(FILTERS.map((f) => [f.id, f]));

export const ADJ_KEYS = [
  ['bright', '밝기'], ['contrast', '대비'], ['sat', '채도'], ['temp', '온도'],
  ['tint', '색조'], ['sharp', '선명'], ['vignette', '비네트'],
];

export function effectiveFx(clip, original) {
  const e = { bright: 0, contrast: 0, sat: 0, temp: 0, tint: 0, sharp: 0, vignette: 0, sepia: 0, gray: 0 };
  if (original || !clip) return e;
  const a = clip.adj || {};
  for (const k of Object.keys(e)) e[k] = a[k] || 0;
  const f = clip.filter && FILTER_MAP[clip.filter.id];
  if (f) {
    const s = clip.filter.strength ?? 1;
    for (const [k, v] of Object.entries(f.p)) e[k] += v * s;
  }
  return e;
}
export function hasFx(e) { return Object.values(e).some((v) => Math.abs(v) > 0.01); }

let sharpReady = false;
function ensureSharpFilters() {
  if (sharpReady) return;
  sharpReady = true;
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', '0'); svg.setAttribute('height', '0');
  svg.style.position = 'absolute'; svg.style.pointerEvents = 'none';
  for (let i = 1; i <= 5; i++) {
    const a = (i * 0.14).toFixed(3), c = (1 + 4 * i * 0.14).toFixed(3);
    const f = document.createElementNS(NS, 'filter');
    f.setAttribute('id', 'nc-sharp-' + i);
    f.setAttribute('color-interpolation-filters', 'sRGB');
    const m = document.createElementNS(NS, 'feConvolveMatrix');
    m.setAttribute('order', '3');
    m.setAttribute('kernelMatrix', `0 -${a} 0 -${a} ${c} -${a} 0 -${a} 0`);
    m.setAttribute('preserveAlpha', 'true');
    f.append(m); svg.append(f);
  }
  document.body.append(svg);
}

export function cssFilter(e, k = 1) {
  const parts = [];
  if (e.sharp > 4) { ensureSharpFilters(); parts.push(`url(#nc-sharp-${clamp(Math.round(e.sharp / 20), 1, 5)})`); }
  if (e.bright) parts.push(`brightness(${(1 + e.bright / 100 * 0.6).toFixed(3)})`);
  if (e.contrast) parts.push(`contrast(${Math.max(0, 1 + e.contrast / 100 * (e.contrast > 0 ? 0.8 : 0.6)).toFixed(3)})`);
  if (e.sat) parts.push(`saturate(${Math.max(0, 1 + e.sat / 100).toFixed(3)})`);
  if (e.sepia) parts.push(`sepia(${clamp(e.sepia / 100, 0, 1).toFixed(3)})`);
  if (e.gray) parts.push(`grayscale(${clamp(e.gray / 100, 0, 1).toFixed(3)})`);
  if (e.sharp < -4) parts.push(`blur(${(-e.sharp / 100 * 4 * k).toFixed(2)}px)`);
  return parts.length ? parts.join(' ') : 'none';
}

// 색 덧칠(온도·색조)과 비네트: 이미 잘라 둔(clip) 영역 안에서 그린다
export function drawColorOverlays(x, e, rect) {
  const { l, t, w, hgt } = rect;
  if (Math.abs(e.temp) > 0.5) {
    x.save();
    x.globalCompositeOperation = 'overlay';
    x.globalAlpha *= clamp(Math.abs(e.temp) / 100, 0, 1) * 0.42;
    x.fillStyle = e.temp > 0 ? 'rgb(255,140,30)' : 'rgb(30,120,255)';
    x.fillRect(l, t, w, hgt);
    x.restore();
  }
  if (Math.abs(e.tint) > 0.5) {
    x.save();
    x.globalCompositeOperation = 'overlay';
    x.globalAlpha *= clamp(Math.abs(e.tint) / 100, 0, 1) * 0.32;
    x.fillStyle = e.tint > 0 ? 'rgb(255,40,200)' : 'rgb(40,220,90)';
    x.fillRect(l, t, w, hgt);
    x.restore();
  }
  if (Math.abs(e.vignette) > 0.5) {
    const cx = l + w / 2, cy = t + hgt / 2, r = Math.hypot(w, hgt) / 2;
    const g = x.createRadialGradient(cx, cy, r * 0.35, cx, cy, r);
    const a = clamp(Math.abs(e.vignette) / 100, 0, 1) * 0.85;
    const col = e.vignette > 0 ? '0,0,0' : '255,255,255';
    g.addColorStop(0, `rgba(${col},0)`);
    g.addColorStop(1, `rgba(${col},${a})`);
    x.save();
    x.fillStyle = g;
    x.fillRect(l, t, w, hgt);
    x.restore();
  }
}

// 글꼴
export const FONTS = [
  { id: 'Noto Sans KR', name: '노토 산스' },
  { id: 'Black Han Sans', name: '검은고딕' },
  { id: 'Jua', name: '주아' },
  { id: 'Do Hyeon', name: '도현' },
  { id: 'Nanum Pen Script', name: '나눔 펜 손글씨' },
  { id: 'Gaegu', name: '개구' },
  { id: 'Nanum Myeongjo', name: '나눔명조' },
];

const baseStyle = {
  font: 'Noto Sans KR', size: 80, color: '#ffffff', bold: true, italic: false, align: 'center', lineH: 1.25,
  strokeW: 0, stroke: '#000000', shadow: false, shadowColor: '#000000', shadowBlur: 10,
  box: false, boxColor: '#000000', boxOpacity: 0.75,
};
export const TEXT_PRESETS = [
  { id: 'basic', name: '기본', s: {} },
  { id: 'sub', name: '자막(검은 테두리)', s: { strokeW: 8, stroke: '#000000', y: 0.82 } },
  { id: 'yellow', name: '노란 강조', s: { color: '#ffe14d', strokeW: 8, stroke: '#111111', font: 'Black Han Sans', bold: false } },
  { id: 'box', name: '검은 박스', s: { box: true, boxColor: '#000000', boxOpacity: 0.8, size: 64, y: 0.82 } },
  { id: 'variety', name: '예능 자막', s: { font: 'Black Han Sans', bold: false, size: 96, color: '#ffffff', strokeW: 12, stroke: '#ff3d7f', shadow: true, shadowColor: '#5a0026', shadowBlur: 0 } },
  { id: 'marker', name: '형광펜', s: { color: '#111111', box: true, boxColor: '#fff200', boxOpacity: 1, font: 'Do Hyeon', bold: false } },
  { id: 'neon', name: '네온', s: { color: '#7df9ff', shadow: true, shadowColor: '#00d4c8', shadowBlur: 30, font: 'Do Hyeon', bold: false } },
  { id: 'hand', name: '손글씨', s: { font: 'Nanum Pen Script', bold: false, size: 110, strokeW: 4, stroke: '#333333' } },
  { id: 'cute', name: '귀여운', s: { font: 'Jua', bold: false, color: '#ff7eb6', strokeW: 9, stroke: '#ffffff', shadow: true, shadowColor: '#00000066', shadowBlur: 8 } },
  { id: 'news', name: '뉴스 자막', s: { font: 'Do Hyeon', bold: false, size: 64, box: true, boxColor: '#1747c9', boxOpacity: 0.95, align: 'left', y: 0.85 } },
  { id: 'warn', name: '빨간 경고', s: { font: 'Black Han Sans', bold: false, color: '#ff2b2b', strokeW: 9, stroke: '#ffffff', size: 100 } },
  { id: 'serif', name: '감성 명조', s: { font: 'Nanum Myeongjo', bold: false, size: 70, shadow: true, shadowColor: '#000000aa', shadowBlur: 14 } },
];
export function presetStyle(id) {
  const p = TEXT_PRESETS.find((x) => x.id === id) || TEXT_PRESETS[0];
  const { y, ...rest } = p.s;
  return { style: { ...baseStyle, ...rest, preset: p.id }, y: y ?? 0.5 };
}

// 스티커(이모지)
export const STICKERS = [
  { name: '동물', items: ['🐶', '🐰', '🐻', '🐼', '🦊', '🐯', '🦁', '🐸', '🐵', '🐧', '🐥', '🦄', '🐬', '🦋', '🐝', '🐹'] },
  { name: '하트', items: ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '💖', '💕', '💘', '💗', '💓', '💞', '💝', '🫶'] },
  { name: '불·반짝', items: ['🔥', '✨', '⭐', '🌟', '💥', '💫', '⚡', '🎉', '🎊', '💯', '🌈', '☀️', '🎆', '🎇', '💎', '👑'] },
  { name: '화살표', items: ['⬆️', '⬇️', '⬅️', '➡️', '↗️', '↘️', '↙️', '↖️', '🔄', '🔁', '👉', '👈', '👆', '👇', '☝️', '🔜'] },
  { name: '말풍선', items: ['💬', '💭', '🗯️', '❗', '❓', '‼️', '⁉️', '❕', '❔', '💤', '🆗', '🆕', '🆒', '🔊', '📢', '📣'] },
  { name: '표정', items: ['😂', '🤣', '😍', '😎', '🥺', '😱', '🤔', '😡', '🥰', '😭', '🤩', '😴', '🤭', '😳', '👍', '👏'] },
];
export const EMOJI_FONT = '"Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji","Twemoji Mozilla",sans-serif';

// 전환
export const TRANSITIONS = [
  { id: 'dissolve', name: '디졸브' },
  { id: 'black', name: '검정 페이드' },
  { id: 'white', name: '흰색 페이드' },
  { id: 'pushL', name: '왼쪽으로 밀기' },
  { id: 'pushR', name: '오른쪽으로 밀기' },
  { id: 'pushU', name: '위로 밀기' },
  { id: 'pushD', name: '아래로 밀기' },
  { id: 'zoom', name: '확대' },
  { id: 'wipe', name: '와이프' },
  { id: 'blur', name: '흐림' },
];
export const TRANS_NAME = Object.fromEntries(TRANSITIONS.map((t) => [t.id, t.name]));

// 애니메이션
export const ANIMS = [
  { id: 'none', name: '없음' },
  { id: 'fade', name: '페이드' },
  { id: 'zoomIn', name: '확대' },
  { id: 'zoomOut', name: '축소' },
  { id: 'slideL', name: '왼쪽에서' },
  { id: 'slideR', name: '오른쪽에서' },
  { id: 'slideB', name: '아래에서' },
  { id: 'pop', name: '팝' },
  { id: 'shake', name: '흔들기' },
  { id: 'type', name: '타자기', textOnly: true },
];
export const ANIM_OUT_NAME = { slideL: '왼쪽으로', slideR: '오른쪽으로', slideB: '아래로' };

export const NOANIM = Object.freeze({ alpha: 1, scale: 1, dx: 0, dy: 0, rot: 0, typeFrac: 1 });
export function animState(clip, t, W, H) {
  const s = { alpha: 1, scale: 1, dx: 0, dy: 0, rot: 0, typeFrac: 1 };
  if (!clip.anim) return s;
  const local = t - clip.start, rem = clip.start + clip.dur - t;
  apply(s, clip.anim.in, local, W, H);
  apply(s, clip.anim.out, rem, W, H);
  return s;
}
function apply(s, a, x, W, H) {
  if (!a || a.type === 'none') return;
  const d = Math.max(0.05, a.dur || 0.5);
  if (x >= d) return;
  const e = clamp(x / d, 0, 1), q = easeOut(e);
  switch (a.type) {
    case 'fade': s.alpha *= e; break;
    case 'zoomIn': s.scale *= 0.4 + 0.6 * q; s.alpha *= Math.min(1, e * 2); break;
    case 'zoomOut': s.scale *= 1.6 - 0.6 * q; s.alpha *= Math.min(1, e * 2); break;
    case 'slideL': s.dx -= (1 - q) * W; break;
    case 'slideR': s.dx += (1 - q) * W; break;
    case 'slideB': s.dy += (1 - q) * H * 0.7; s.alpha *= Math.min(1, e * 1.5); break;
    case 'pop': s.scale *= Math.max(0.01, backOut(e)); s.alpha *= Math.min(1, e * 3); break;
    case 'shake': {
      const amp = (1 - e);
      s.rot += Math.sin(e * Math.PI * 7) * amp * 0.18;
      s.dx += Math.sin(e * Math.PI * 9) * amp * W * 0.03;
      break;
    }
    case 'type': s.typeFrac = Math.min(s.typeFrac, e); break;
    default: break;
  }
}
