// 분할 화면(콜라주): 레이아웃 정의 + 그리기 (미리보기·내보내기·사진 저장 공용)
import { media } from './media.js';

const R = (x, y, w, h) => ({ t: 'r', x, y, w, h });
const P = (...pts) => ({ t: 'p', pts });
const C = (cx, cy, r) => ({ t: 'c', cx, cy, r }); // r은 짧은 변 기준 비율
const grid = (cols, rows) => {
  const out = [];
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) out.push(R(i / cols, j / rows, 1 / cols, 1 / rows));
  return out;
};

export const LAYOUTS = [
  { id: 'lr2', name: '좌우 2칸', cells: [R(0, 0, 0.5, 1), R(0.5, 0, 0.5, 1)] },
  { id: 'tb2', name: '위아래 2칸', cells: [R(0, 0, 1, 0.5), R(0, 0.5, 1, 0.5)] },
  { id: 'lr3', name: '좌우 3칸', cells: grid(3, 1) },
  { id: 'tb3', name: '위아래 3칸', cells: grid(1, 3) },
  { id: 'lr4', name: '좌우 4칸', cells: grid(4, 1) },
  { id: 'tb4', name: '위아래 4칸', cells: grid(1, 4) },
  { id: 'big-l', name: '왼쪽 큰 칸 + 2칸', cells: [R(0, 0, 0.6, 1), R(0.6, 0, 0.4, 0.5), R(0.6, 0.5, 0.4, 0.5)] },
  { id: 'big-t', name: '위 큰 칸 + 2칸', cells: [R(0, 0, 1, 0.6), R(0, 0.6, 0.5, 0.4), R(0.5, 0.6, 0.5, 0.4)] },
  { id: 'g4', name: '4칸 (2×2)', cells: grid(2, 2) },
  { id: 'g6', name: '6칸 (2×3)', cells: grid(2, 3) },
  { id: 'g6w', name: '6칸 (3×2)', cells: grid(3, 2) },
  { id: 'g9', name: '9칸 (3×3)', cells: grid(3, 3) },
  { id: 'diag', name: '대각선 2칸', cells: [P([0, 0], [1, 0], [0, 1]), P([1, 0], [1, 1], [0, 1])] },
  { id: 'diag2', name: '대각선 2칸 (반대)', cells: [P([0, 0], [1, 0], [1, 1]), P([0, 0], [1, 1], [0, 1])] },
  { id: 'circle', name: '4칸 + 가운데 원', cells: [...grid(2, 2), C(0.5, 0.5, 0.26)] },
  { id: 'r73', name: '위 7 : 아래 3', cells: [R(0, 0, 1, 0.7), R(0, 0.7, 1, 0.3)] },
  { id: 'r37', name: '위 3 : 아래 7', cells: [R(0, 0, 1, 0.3), R(0, 0.3, 1, 0.7)] },
  { id: 'l1r3', name: '왼쪽 1 + 오른쪽 3', cells: [R(0, 0, 0.5, 1), R(0.5, 0, 0.5, 1 / 3), R(0.5, 1 / 3, 0.5, 1 / 3), R(0.5, 2 / 3, 0.5, 1 / 3)] },
  { id: 't1b3', name: '위 1 + 아래 3', cells: [R(0, 0, 1, 0.55), R(0, 0.55, 1 / 3, 0.45), R(1 / 3, 0.55, 1 / 3, 0.45), R(2 / 3, 0.55, 1 / 3, 0.45)] },
];
export const LAYOUT_MAP = Object.fromEntries(LAYOUTS.map((l) => [l.id, l]));
export const layoutOf = (c) => LAYOUT_MAP[c.collage?.layout] || LAYOUTS[0];
export const cellCount = (c) => layoutOf(c).cells.length;
export const newCell = () => ({ mediaId: null, px: 0, py: 0, zoom: 1, muted: false });

// 칸 하나의 실제 모양(픽셀). gap만큼 칸 사이를 띄운다.
export function cellShape(cell, W, H, gap) {
  const g = Math.max(0, gap || 0);
  const fx = g / 2, fy = g / 2, fW = W - g, fH = H - g;
  if (cell.t === 'r') {
    const x = fx + cell.x * fW + g / 2, y = fy + cell.y * fH + g / 2;
    const w = Math.max(1, cell.w * fW - g), h = Math.max(1, cell.h * fH - g);
    return { t: 'r', x, y, w, h, bx: x, by: y, bw: w, bh: h };
  }
  if (cell.t === 'p') {
    const pts = cell.pts.map(([px, py]) => [fx + px * fW, fy + py * fH]);
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const bx = Math.min(...xs), by = Math.min(...ys);
    return { t: 'p', pts, bx, by, bw: Math.max(...xs) - bx, bh: Math.max(...ys) - by, g };
  }
  const r = cell.r * Math.min(W, H);
  const cx = cell.cx * W, cy = cell.cy * H;
  return { t: 'c', cx, cy, r, bx: cx - r, by: cy - r, bw: r * 2, bh: r * 2, g };
}
export function cellShapes(c, W, H) {
  const gap = (c.collage?.gap || 0) * Math.min(W, H) / 1080;
  return layoutOf(c).cells.map((cell) => cellShape(cell, W, H, gap));
}
function pathOf(x, s, radius) {
  x.beginPath();
  if (s.t === 'r') {
    const rr = Math.min(radius, s.w / 2, s.h / 2);
    if (rr > 0.5 && x.roundRect) x.roundRect(s.x, s.y, s.w, s.h, rr); else x.rect(s.x, s.y, s.w, s.h);
  } else if (s.t === 'p') {
    s.pts.forEach(([px, py], i) => (i ? x.lineTo(px, py) : x.moveTo(px, py)));
    x.closePath();
  } else x.arc(s.cx, s.cy, s.r, 0, Math.PI * 2);
}
// 점이 칸 안에 있나(위에 그려지는 칸부터 찾는다)
export function cellAt(c, W, H, px, py) {
  const shapes = cellShapes(c, W, H);
  for (let i = shapes.length - 1; i >= 0; i--) {
    const s = shapes[i];
    if (s.t === 'r' && px >= s.x && px <= s.x + s.w && py >= s.y && py <= s.y + s.h) return i;
    if (s.t === 'c' && Math.hypot(px - s.cx, py - s.cy) <= s.r) return i;
    if (s.t === 'p' && inPoly(s.pts, px, py)) return i;
  }
  return -1;
}
function inPoly(pts, x, y) {
  let ins = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) ins = !ins;
  }
  return ins;
}

// 칸 안에 원본을 꽉 차게(cover) 놓을 때의 크기·위치
export function coverGeom(s, iw, ih, cell) {
  const z = Math.max(1, cell.zoom || 1);
  const sc = Math.max(s.bw / iw, s.bh / ih) * z;
  const dw = iw * sc, dh = ih * sc;
  const mx = Math.max(0, (dw - s.bw) / 2), my = Math.max(0, (dh - s.bh) / 2);
  const cx = s.bx + s.bw / 2 + (cell.px || 0) * mx, cy = s.by + s.bh / 2 + (cell.py || 0) * my;
  return { dw, dh, mx, my, x: cx - dw / 2, y: cy - dh / 2 };
}

// 칸에 든 영상·사진을 보통 클립처럼 다루기 위한 가상 클립
export function cellClip(c, i) {
  const cell = c.collage?.cells?.[i];
  if (!cell || !cell.mediaId) return null;
  const m = media.get(cell.mediaId);
  if (!m || m.kind === 'audio') return null;
  return {
    id: c.id + '~' + i, type: m.kind === 'video' ? 'video' : 'image', mediaId: m.id, name: m.name,
    start: c.start, dur: c.dur, in: c.in || 0, speed: c.speed || 1,
    volume: c.volume ?? 1, fadeIn: c.fadeIn || 0, fadeOut: c.fadeOut || 0,
    muted: !!(c.muted || cell.muted), disabled: !!c.disabled, parent: c.id,
  };
}
export function cellClips(c) {
  const out = [];
  const n = cellCount(c);
  for (let i = 0; i < n; i++) { const v = cellClip(c, i); if (v) out.push(v); }
  return out;
}

// 콜라주 전체 그리기. x는 이미 (k,k) 배율이 걸린 상태, 좌표는 W×H 기준
// getSrc(virtualClip) → {img,w,h} | null
export function drawCollage(x, c, W, H, getSrc, o = {}) {
  const col = c.collage || {};
  const bg = col.color || '#ffffff';
  const radius = (col.radius || 0) * Math.min(W, H) / 1080;
  const shapes = cellShapes(c, W, H);
  x.save();
  x.fillStyle = bg;
  x.fillRect(0, 0, W, H);
  shapes.forEach((s, i) => {
    const cell = col.cells?.[i] || newCell();
    const v = cellClip(c, i);
    const src = v ? getSrc(v) : null;
    x.save();
    if (s.t === 'c') {
      // 가운데 원: 테두리 고리를 먼저 깔아 아래 칸과 떼어 놓는다
      if (s.g > 0) { x.beginPath(); x.arc(s.cx, s.cy, s.r + s.g, 0, Math.PI * 2); x.fillStyle = bg; x.fill(); }
    }
    pathOf(x, s, radius);
    x.clip();
    if (src && src.w && src.h) {
      const gm = coverGeom(s, src.w, src.h, cell);
      try { x.drawImage(src.img, gm.x, gm.y, gm.dw, gm.dh); } catch (e) { /* 아직 준비 안 된 프레임 */ }
    } else if (o.cellFill) {
      x.fillStyle = o.cellFill; x.fillRect(s.bx, s.by, s.bw, s.bh);
    } else if (o.preview) {
      // 미리보기에서만 빈 칸 표시(내보낼 때는 배경색)
      x.fillStyle = 'rgba(128,128,140,0.35)'; x.fillRect(s.bx, s.by, s.bw, s.bh);
      const fs = Math.max(12, Math.min(s.bw, s.bh) * 0.22);
      x.fillStyle = 'rgba(255,255,255,0.85)';
      x.font = `700 ${fs}px "Noto Sans KR", sans-serif`;
      x.textAlign = 'center'; x.textBaseline = 'middle';
      x.fillText('＋', s.bx + s.bw / 2, s.by + s.bh / 2);
    }
    x.restore();
    if (s.t === 'p' && s.g > 0) {
      // 대각선 칸 사이 간격은 테두리 선으로
      pathOf(x, s, 0);
      x.lineJoin = 'round';
      x.lineWidth = s.g; x.strokeStyle = bg; x.stroke();
    }
  });
  x.restore();
}

// 작은 그림(레이아웃 고르기·타임라인)
export function drawLayoutThumb(cv, layoutId, opt = {}) {
  const x = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  x.setTransform(1, 0, 0, 1, 0, 0);
  x.clearRect(0, 0, W, H);
  const fake = { id: 'thumb', collage: { layout: layoutId, gap: (opt.gap ?? 4) * 1080 / Math.min(W, H), radius: 0, color: opt.bg || '#2a2a33', cells: [] } };
  drawCollage(x, fake, W, H, () => null, { cellFill: opt.fill || '#5a5a68' });
}
