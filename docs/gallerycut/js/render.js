// 시간 t → 캔버스 그리기 (미리보기·내보내기·사진 저장이 모두 이 함수를 쓴다)
import { media } from './media.js';
import { clipEnd, mainSceneAt } from './model.js';
import { effectiveFx, cssFilter, drawColorOverlays, animState, NOANIM, EMOJI_FONT } from './effects.js';
import { easeInOut } from './util.js';
import { drawCollage } from './collage.js';

// 분할 화면은 프로젝트 화면 크기(W×H)짜리 그림으로 취급한다
export function clipMedia(c, W, H) {
  if (c.type === 'collage') return { width: W, height: H };
  return media.get(c.mediaId);
}
const collageCv = [];
function renderCollageSrc(idx, clip, t, provider, o) {
  const pw = Math.max(2, Math.round(o.W * o.k)), ph = Math.max(2, Math.round(o.H * o.k));
  let c = collageCv[idx];
  if (!c) { c = document.createElement('canvas'); collageCv[idx] = c; }
  if (c.width !== pw || c.height !== ph) { c.width = pw; c.height = ph; }
  const x = c.getContext('2d');
  x.setTransform(pw / o.W, 0, 0, ph / o.H, 0, 0);
  x.globalAlpha = 1; x.filter = 'none';
  drawCollage(x, clip, o.W, o.H, (v) => provider.get(v, t), { preview: !!o.preview });
  return { img: c, w: pw, h: ph };
}

const layers = [];
function getLayer(i, pw, ph) {
  let c = layers[i];
  if (!c) { c = document.createElement('canvas'); layers[i] = c; }
  if (c.width !== pw || c.height !== ph) { c.width = pw; c.height = ph; }
  const x = c.getContext('2d');
  x.setTransform(1, 0, 0, 1, 0, 0);
  x.globalAlpha = 1; x.globalCompositeOperation = 'source-over'; x.filter = 'none';
  x.clearRect(0, 0, pw, ph);
  return { c, x };
}

// 미디어 배치 계산(선택 상자에도 씀)
export function mediaGeom(clip, m, W, H) {
  const sw = (m && m.width) || 16, sh = (m && m.height) || 9;
  const r = (((clip.rot90 || 0) % 360) + 360) % 360;
  const rot = r === 90 || r === 270;
  const OW = rot ? sh : sw, OH = rot ? sw : sh;
  const cr = clip.crop || { x: 0, y: 0, w: 1, h: 1 };
  const ow = OW * cr.w, oh = OH * cr.h;
  const s = clip.fit === 'fill' ? Math.max(W / ow, H / oh) : Math.min(W / ow, H / oh);
  const tf = clip.tf;
  return { sw, sh, r, OW, OH, ox: OW * cr.x, oy: OH * cr.y, ow, oh, dw: ow * s * tf.scale, dh: oh * s * tf.scale, cx: tf.x * W, cy: tf.y * H };
}

// 회전(90도 단위)과 자르기를 반영해 원본을 (-dw/2,-dh/2,dw,dh)에 그린다
function drawOriented(x, src, g, dw, dh) {
  const fx = src.w / g.sw, fy = src.h / g.sh; // 실제 소스 해상도 보정
  const { r, ox, oy, ow, oh, sw, sh } = g;
  let sx, sy, sW, sH, w = dw, hh = dh;
  if (r === 0) { sx = ox; sy = oy; sW = ow; sH = oh; }
  else if (r === 90) { sx = oy; sy = sh - ox - ow; sW = oh; sH = ow; w = dh; hh = dw; }
  else if (r === 180) { sx = sw - ox - ow; sy = sh - oy - oh; sW = ow; sH = oh; }
  else { sx = sw - oy - oh; sy = ox; sW = oh; sH = ow; w = dh; hh = dw; }
  if (r) x.rotate(r * Math.PI / 180);
  try {
    x.drawImage(src.img, sx * fx, sy * fy, Math.max(1, sW * fx), Math.max(1, sH * fy), -w / 2, -hh / 2, w, hh);
  } catch (e) { /* 아직 준비 안 된 프레임 */ }
}

function drawBg(x, clip, src, m, o) {
  const bg = clip.bg;
  if (!bg || bg.type === 'none') return;
  if (bg.type === 'color') {
    x.fillStyle = bg.color || '#000';
    x.fillRect(0, 0, o.W, o.H);
    return;
  }
  if (bg.type === 'blur' && src) {
    const g = mediaGeom({ ...clip, fit: 'fill', tf: { ...clip.tf, scale: 1.08, x: 0.5, y: 0.5 } }, m, o.W, o.H);
    x.save();
    x.translate(o.W / 2, o.H / 2);
    x.filter = `blur(${Math.round(28 * o.k)}px) brightness(0.85)`;
    drawOriented(x, src, g, g.dw, g.dh);
    x.restore();
    x.filter = 'none';
  }
}

function renderMediaLayer(idx, p, clip, t, provider, o, isMain) {
  const { c, x } = getLayer(idx, o.pw, o.ph);
  x.setTransform(o.k, 0, 0, o.k, 0, 0);
  const isCol = clip.type === 'collage';
  const m = clipMedia(clip, o.W, o.H);
  const src = isCol ? renderCollageSrc(idx, clip, t, provider, o) : provider.get(clip, t);
  if (isMain) drawBg(x, clip, src, m, o);
  if (!src || !m) return c;
  const an = o.noAnim ? NOANIM : animState(clip, t, o.W, o.H);
  const g = mediaGeom(clip, m, o.W, o.H);
  const tf = clip.tf;
  const e = effectiveFx(clip, o.original);
  x.save();
  x.globalAlpha = Math.max(0, Math.min(1, tf.opacity * an.alpha));
  x.translate(g.cx + an.dx, g.cy + an.dy);
  x.rotate((tf.rot || 0) * Math.PI / 180 + an.rot);
  x.scale((tf.flipH ? -1 : 1) * an.scale, (tf.flipV ? -1 : 1) * an.scale);
  x.filter = cssFilter(e, o.k);
  x.save();
  drawOriented(x, src, g, g.dw, g.dh);
  x.restore();
  x.filter = 'none';
  x.beginPath(); x.rect(-g.dw / 2, -g.dh / 2, g.dw, g.dh); x.clip();
  drawColorOverlays(x, e, { l: -g.dw / 2, t: -g.dh / 2, w: g.dw, hgt: g.dh });
  x.restore();
  return c;
}

function blit(ctx, c, alpha = 1, dx = 0, dy = 0) {
  if (alpha <= 0) return;
  ctx.globalAlpha = alpha;
  ctx.drawImage(c, dx, dy);
  ctx.globalAlpha = 1;
}

function compositeTransition(ctx, A, B, type, pr, o) {
  const pw = o.pw, ph = o.ph, e = easeInOut(Math.max(0, Math.min(1, pr)));
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  switch (type) {
    case 'black': case 'white': {
      const col = type === 'black' ? '#000' : '#fff';
      if (pr < 0.5) { blit(ctx, A); ctx.globalAlpha = pr * 2; } else { blit(ctx, B); ctx.globalAlpha = (1 - pr) * 2; }
      ctx.fillStyle = col; ctx.fillRect(0, 0, pw, ph); ctx.globalAlpha = 1;
      break;
    }
    case 'pushL': blit(ctx, A, 1, -e * pw, 0); blit(ctx, B, 1, (1 - e) * pw, 0); break;
    case 'pushR': blit(ctx, A, 1, e * pw, 0); blit(ctx, B, 1, -(1 - e) * pw, 0); break;
    case 'pushU': blit(ctx, A, 1, 0, -e * ph); blit(ctx, B, 1, 0, (1 - e) * ph); break;
    case 'pushD': blit(ctx, A, 1, 0, e * ph); blit(ctx, B, 1, 0, -(1 - e) * ph); break;
    case 'zoom': {
      blit(ctx, B);
      const s = 1 + e * 0.9;
      ctx.save();
      ctx.translate(pw / 2, ph / 2); ctx.scale(s, s); ctx.translate(-pw / 2, -ph / 2);
      blit(ctx, A, 1 - e);
      ctx.restore();
      break;
    }
    case 'wipe': {
      blit(ctx, A);
      ctx.save(); ctx.beginPath(); ctx.rect(0, 0, e * pw, ph); ctx.clip(); blit(ctx, B); ctx.restore();
      break;
    }
    case 'blur': {
      const bl = (1 - Math.abs(pr - 0.5) * 2) * 26 * o.k;
      ctx.filter = bl > 0.3 ? `blur(${bl.toFixed(1)}px)` : 'none';
      blit(ctx, A); blit(ctx, B, e);
      ctx.filter = 'none';
      break;
    }
    default: blit(ctx, A); blit(ctx, B, e); // 디졸브
  }
}

// 텍스트 배치 계산
const mctx = document.createElement('canvas').getContext('2d');
export function fontStr(st, size) {
  return `${st.italic ? 'italic ' : ''}${st.bold ? '700' : '400'} ${size ?? st.size}px "${st.font}", "Noto Sans KR", sans-serif`;
}
export function textLayout(c) {
  const st = c.text;
  mctx.font = fontStr(st);
  const lines = String(st.content || ' ').split('\n');
  let w = 0;
  const ws = lines.map((l) => { const mw = mctx.measureText(l || ' ').width; w = Math.max(w, mw); return mw; });
  const lh = st.size * (st.lineH || 1.25);
  const pad = st.box ? st.size * 0.32 : st.strokeW || 0;
  return { lines, ws, w, h: lh * lines.length, lh, pad };
}
export function clipBounds(c, W, H) {
  const tf = c.tf;
  if (c.type === 'text') {
    const L = textLayout(c);
    return { cx: tf.x * W, cy: tf.y * H, w: (L.w + L.pad * 2) * tf.scale, h: (L.h + L.pad * 2) * tf.scale, rot: tf.rot || 0 };
  }
  if (c.type === 'sticker') {
    const s = c.sticker.size * 1.15 * tf.scale;
    return { cx: tf.x * W, cy: tf.y * H, w: s, h: s, rot: tf.rot || 0 };
  }
  const m = clipMedia(c, W, H);
  const g = mediaGeom(c, m, W, H);
  return { cx: g.cx, cy: g.cy, w: g.dw, h: g.dh, rot: tf.rot || 0 };
}
function hexA(col, a) {
  if (/^#[0-9a-f]{6}$/i.test(col)) {
    const n = parseInt(col.slice(1), 16);
    return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
  }
  return col;
}
function drawText(ctx, c, t, o) {
  const st = c.text, tf = c.tf;
  const an = o.noAnim ? NOANIM : animState(c, t, o.W, o.H);
  const L = textLayout(c);
  ctx.save();
  ctx.setTransform(o.k, 0, 0, o.k, 0, 0);
  ctx.globalAlpha = Math.max(0, Math.min(1, tf.opacity * an.alpha));
  ctx.translate(tf.x * o.W + an.dx, tf.y * o.H + an.dy);
  ctx.rotate((tf.rot || 0) * Math.PI / 180 + an.rot);
  const sc = tf.scale * an.scale;
  ctx.scale(sc * (tf.flipH ? -1 : 1), sc * (tf.flipV ? -1 : 1));
  const devScale = o.k * sc;
  if (st.box) {
    const bw = L.w + L.pad * 2, bh = L.h + L.pad * 2, r = Math.min(bh / 2, st.size * 0.25);
    ctx.fillStyle = hexA(st.boxColor, st.boxOpacity ?? 0.8);
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(-bw / 2, -bh / 2, bw, bh, r); else ctx.rect(-bw / 2, -bh / 2, bw, bh);
    ctx.fill();
  }
  ctx.font = fontStr(st);
  ctx.textBaseline = 'middle';
  ctx.textAlign = st.align || 'center';
  const ax = st.align === 'left' ? -L.w / 2 : st.align === 'right' ? L.w / 2 : 0;
  const total = L.lines.reduce((a, l) => a + Array.from(l).length, 0);
  let show = an.typeFrac >= 1 ? Infinity : Math.floor(total * an.typeFrac + 1e-6);
  ctx.lineJoin = 'round'; ctx.miterLimit = 2;
  L.lines.forEach((line, i) => {
    let s = line;
    if (show !== Infinity) { const ch = Array.from(line); s = ch.slice(0, Math.max(0, show)).join(''); show -= ch.length; }
    if (!s) return;
    const y = -L.h / 2 + L.lh * (i + 0.5);
    if (st.shadow) {
      ctx.shadowColor = st.shadowColor || '#000';
      ctx.shadowBlur = (st.shadowBlur ?? 10) * devScale;
      ctx.shadowOffsetX = st.size * 0.05 * devScale;
      ctx.shadowOffsetY = st.size * 0.06 * devScale;
    }
    if (st.strokeW > 0) {
      ctx.lineWidth = st.strokeW * 2;
      ctx.strokeStyle = st.stroke;
      ctx.strokeText(s, ax, y);
      ctx.shadowColor = 'transparent';
    }
    ctx.fillStyle = st.color;
    ctx.fillText(s, ax, y);
    ctx.shadowColor = 'transparent';
  });
  ctx.restore();
}
function drawSticker(ctx, c, t, o) {
  const tf = c.tf;
  const an = o.noAnim ? NOANIM : animState(c, t, o.W, o.H);
  ctx.save();
  ctx.setTransform(o.k, 0, 0, o.k, 0, 0);
  ctx.globalAlpha = Math.max(0, Math.min(1, tf.opacity * an.alpha));
  ctx.translate(tf.x * o.W + an.dx, tf.y * o.H + an.dy);
  ctx.rotate((tf.rot || 0) * Math.PI / 180 + an.rot);
  const sc = tf.scale * an.scale;
  ctx.scale(sc * (tf.flipH ? -1 : 1), sc * (tf.flipV ? -1 : 1));
  ctx.font = `${c.sticker.size}px ${EMOJI_FONT}`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(c.sticker.emoji, 0, c.sticker.size * 0.04);
  ctx.restore();
}

function drawOne(ctx, p, c, t, provider, o) {
  if (o.hideId === c.id) return;
  if (c.type === 'text') return drawText(ctx, c, t, o);
  if (c.type === 'sticker') return drawSticker(ctx, c, t, o);
  if (c.type === 'video' || c.type === 'image' || c.type === 'collage') {
    const L = renderMediaLayer(2, p, c, t, provider, o, false);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    blit(ctx, L);
  }
}

// o: { W, H, k, pw, ph, original, noAnim, hideId }
export function renderFrame(ctx, p, t, provider, o) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1; ctx.filter = 'none'; ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = p.bg || '#000';
  ctx.fillRect(0, 0, o.pw, o.ph);
  for (let i = p.tracks.length - 1; i >= 0; i--) {
    const tr = p.tracks[i];
    if (tr.hidden || tr.kind === 'audio') continue;
    if (tr.kind === 'main') {
      const sc = mainSceneAt(p, t);
      if (!sc) continue;
      if (!sc.b) {
        const L = renderMediaLayer(0, p, sc.a, t, provider, o, true);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        blit(ctx, L);
      } else {
        const A = renderMediaLayer(0, p, sc.a, t, provider, o, true);
        const B = renderMediaLayer(1, p, sc.b, t, provider, o, true);
        compositeTransition(ctx, A, B, sc.type, sc.p, o);
      }
      continue;
    }
    for (const c of tr.clips) {
      if (c.disabled || t < c.start || t >= clipEnd(c)) continue;
      drawOne(ctx, p, c, t, provider, o);
    }
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
}

// 이미지 클립 공용 공급자
export function imageSource(clip) {
  const m = media.get(clip.mediaId);
  if (!m || !m.bitmap) return null;
  return { img: m.bitmap, w: m.bitmap.width, h: m.bitmap.height };
}

// 패널 미리보기용: 텍스트 스타일 썸네일
export function renderTextThumb(cv, style, content) {
  const x = cv.getContext('2d');
  x.setTransform(1, 0, 0, 1, 0, 0);
  x.clearRect(0, 0, cv.width, cv.height);
  const size = Math.round(cv.height * 0.36);
  const clip = { start: 0, dur: 1, tf: { x: 0.5, y: 0.5, scale: 1, rot: 0, opacity: 1 }, anim: null,
    text: { ...style, align: 'center', size, strokeW: Math.round((style.strokeW || 0) * size / (style.size || 80)), shadowBlur: (style.shadowBlur || 0) * size / (style.size || 80), content } };
  const L = textLayout(clip);
  const fitS = Math.min(1, (cv.width * 0.9) / (L.w + L.pad * 2));
  clip.tf.scale = fitS;
  drawText(x, clip, 0, { W: cv.width, H: cv.height, k: 1, noAnim: true });
}
// 필터 썸네일
export function renderFilterThumb(cv, img, fxParams) {
  const x = cv.getContext('2d');
  x.setTransform(1, 0, 0, 1, 0, 0);
  x.clearRect(0, 0, cv.width, cv.height);
  x.filter = cssFilter(fxParams, cv.width / 400);
  if (img) {
    const s = Math.max(cv.width / img.width, cv.height / img.height);
    const w = img.width * s, hh = img.height * s;
    x.drawImage(img, (cv.width - w) / 2, (cv.height - hh) / 2, w, hh);
  }
  x.filter = 'none';
  drawColorOverlays(x, fxParams, { l: 0, t: 0, w: cv.width, hgt: cv.height });
}
