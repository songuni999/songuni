// 프로젝트 자료 구조와 편집 동작
import { uid, FPS } from './util.js';
import { media } from './media.js';
import { presetStyle } from './effects.js';
import { LAYOUT_MAP, cellClips, cellCount, newCell, layoutOf } from './collage.js';

export const ASPECTS = {
  '9:16': [1080, 1920], '16:9': [1920, 1080], '1:1': [1080, 1080], '4:5': [1080, 1350], '3:4': [1080, 1440],
};
export const ASPECT_NAMES = { '9:16': '9:16 세로(쇼츠·릴스)', '16:9': '16:9 가로(유튜브)', '1:1': '1:1 정사각', '4:5': '4:5 인스타 피드', '3:4': '3:4 세로 사진' };
export const KIND_LABEL = { text: '텍스트', overlay: '오버레이', main: '메인', audio: '오디오' };
export const EPS = 1e-4;

export function canvasSize(p) {
  if (p.aspect === 'custom') return { W: p.w || 1080, H: p.h || 1080 };
  const a = ASPECTS[p.aspect] || ASPECTS['9:16'];
  return { W: a[0], H: a[1] };
}
export function newTrack(kind) { return { id: uid('t'), kind, hidden: false, locked: false, muted: false, clips: [] }; }
export function newProject() {
  return {
    version: 1, name: '제목 없는 프로젝트', aspect: '9:16', bg: '#000000', fitMode: 'fit',
    magnet: true, snap: true, exportRes: 1080,
    tracks: [newTrack('text'), newTrack('overlay'), newTrack('main'), newTrack('audio')],
  };
}
export const defaultTf = () => ({ x: 0.5, y: 0.5, scale: 1, rot: 0, opacity: 1, flipH: false, flipV: false });
export const defaultAdj = () => ({ bright: 0, contrast: 0, sat: 0, temp: 0, tint: 0, sharp: 0, vignette: 0 });
const defaultAnim = () => ({ in: { type: 'none', dur: 0.5 }, out: { type: 'none', dur: 0.5 } });

export function makeMediaClip(m, start, p) {
  const img = m.kind === 'image';
  return {
    id: uid('c'), type: img ? 'image' : 'video', mediaId: m.id, name: m.name,
    start, dur: img ? 3 : Math.max(1 / FPS, m.duration), in: 0, speed: 1,
    volume: 1, fadeIn: 0, fadeOut: 0, muted: false, disabled: false,
    tf: defaultTf(), crop: { x: 0, y: 0, w: 1, h: 1 }, cropRatio: 'free', rot90: 0,
    filter: { id: 'none', strength: 1 }, adj: defaultAdj(), anim: defaultAnim(),
    bg: { type: 'none', color: '#000000' }, fit: p.fitMode || 'fit', transition: null,
  };
}
export function makeAudioClip(m, start) {
  return {
    id: uid('c'), type: 'audio', mediaId: m.id, name: m.name, start,
    dur: Math.max(1 / FPS, m.duration), in: 0, speed: 1, volume: 1, fadeIn: 0, fadeOut: 0, muted: false, disabled: false,
  };
}
export function shortScale(p) { const { W, H } = canvasSize(p); return Math.min(W, H) / 1080; }
export function makeTextClip(presetId, start, p, content) {
  const { style, y } = presetStyle(presetId);
  style.size = Math.round(style.size * shortScale(p));
  style.strokeW = Math.round(style.strokeW * shortScale(p));
  const tf = defaultTf(); tf.y = y;
  return { id: uid('c'), type: 'text', start, dur: 3, disabled: false, tf, anim: defaultAnim(), text: { ...style, content: content || '텍스트를 입력하세요' } };
}
export function makeStickerClip(emoji, start, p) {
  return { id: uid('c'), type: 'sticker', start, dur: 3, disabled: false, tf: defaultTf(), anim: { in: { type: 'pop', dur: 0.4 }, out: { type: 'none', dur: 0.5 } }, sticker: { emoji, size: Math.round(260 * shortScale(p)) } };
}

// 분할 화면(콜라주) 클립
export function makeCollageClip(layoutId, start, p) {
  const lay = LAYOUT_MAP[layoutId] || LAYOUT_MAP.lr2;
  return {
    id: uid('c'), type: 'collage', name: '분할 화면', start, dur: 5, in: 0, speed: 1,
    volume: 1, fadeIn: 0, fadeOut: 0, muted: false, disabled: false,
    tf: defaultTf(), crop: { x: 0, y: 0, w: 1, h: 1 }, cropRatio: 'free', rot90: 0,
    filter: { id: 'none', strength: 1 }, adj: defaultAdj(), anim: defaultAnim(),
    bg: { type: 'none', color: '#000000' }, fit: 'fit', transition: null,
    collage: { layout: lay.id, gap: 12, radius: 0, color: '#ffffff', cells: lay.cells.map(() => newCell()) },
  };
}
// 트랙의 소리·영상 요소가 필요한 클립(분할 화면 칸 속 영상 포함)
export function avClips(tr) {
  const out = [];
  for (const c of tr.clips) {
    if (c.type === 'video' || c.type === 'audio') out.push(c);
    else if (c.type === 'collage') for (const v of cellClips(c)) if (v.type === 'video') out.push(v);
  }
  return out;
}
const expandVideo = (c, out) => {
  if (c.type === 'video') out.push(c);
  else if (c.type === 'collage') for (const v of cellClips(c)) if (v.type === 'video') out.push(v);
};

export const clipEnd = (c) => c.start + c.dur;
export function mediaDur(c) {
  if (c.type !== 'video' && c.type !== 'audio') return Infinity;
  const m = media.get(c.mediaId);
  return m && m.duration ? m.duration : Infinity;
}
export function maxDur(c) { return (mediaDur(c) - (c.in || 0)) / (c.speed || 1); }
export function srcTime(c, t) { return (c.in || 0) + (t - c.start) * (c.speed || 1); }
export function srcTimeClamped(c, t) {
  const d = mediaDur(c);
  return Math.max(0, Math.min(isFinite(d) ? d - 0.001 : 1e9, srcTime(c, t)));
}
export function projectDuration(p) {
  let d = 0;
  for (const tr of p.tracks) for (const c of tr.clips) d = Math.max(d, clipEnd(c));
  return d;
}
export function findClip(p, id) {
  if (!id) return null;
  for (const tr of p.tracks) {
    const i = tr.clips.findIndex((c) => c.id === id);
    if (i >= 0) return { clip: tr.clips[i], track: tr, index: i };
  }
  return null;
}
export const mainTrack = (p) => p.tracks.find((t) => t.kind === 'main');
export const sortTrack = (tr) => tr.clips.sort((a, b) => a.start - b.start);
export function trackKindFor(type) {
  if (type === 'text' || type === 'sticker') return 'text';
  if (type === 'audio') return 'audio';
  return 'overlay';
}
export function accepts(trackKind, type) {
  if (trackKind === 'main' || trackKind === 'overlay') return type === 'video' || type === 'image' || type === 'collage';
  if (trackKind === 'text') return type === 'text' || type === 'sticker';
  if (trackKind === 'audio') return type === 'audio';
  return false;
}
export function packMain(p) {
  const tr = mainTrack(p);
  sortTrack(tr);
  if (!p.magnet) return;
  let t = 0;
  for (const c of tr.clips) { c.start = t; t += c.dur; }
}
export function trackFree(tr, start, dur, exceptId) {
  return !tr.clips.some((c) => c.id !== exceptId && c.start < start + dur - EPS && clipEnd(c) > start + EPS);
}
export function insertTrack(p, kind) {
  const tr = newTrack(kind);
  const idxs = p.tracks.map((t, i) => (t.kind === kind ? i : -1)).filter((i) => i >= 0);
  if (kind === 'audio') p.tracks.splice((idxs.length ? idxs[idxs.length - 1] : p.tracks.length - 1) + 1, 0, tr);
  else p.tracks.splice(idxs.length ? idxs[0] : (kind === 'text' ? 0 : p.tracks.indexOf(mainTrack(p))), 0, tr);
  return tr;
}
// 메인 아닌 트랙에 겹치지 않게 넣기(자리가 없으면 새 트랙)
export function placeClip(p, clip, preferred) {
  const kind = trackKindFor(clip.type);
  const cands = [];
  if (preferred && accepts(preferred.kind, clip.type) && preferred.kind !== 'main') cands.push(preferred);
  for (const t of p.tracks) if (t.kind === kind && !cands.includes(t)) cands.push(t);
  if (kind === 'text' || kind === 'overlay') cands.sort((a, b) => (a === preferred ? -1 : b === preferred ? 1 : p.tracks.indexOf(b) - p.tracks.indexOf(a)));
  for (const tr of cands) {
    if (tr.locked) continue;
    if (trackFree(tr, clip.start, clip.dur)) { tr.clips.push(clip); sortTrack(tr); return tr; }
  }
  const tr = insertTrack(p, kind);
  tr.clips.push(clip);
  return tr;
}
// 메인 트랙에 넣기: 자석이면 at 시각에 가장 가까운 경계에 끼워 넣음
export function addToMain(p, clip, at) {
  const tr = mainTrack(p);
  sortTrack(tr);
  if (p.magnet) {
    if (at == null) { clip.start = 1e9; tr.clips.push(clip); }
    else {
      let idx = tr.clips.length;
      for (let i = 0; i < tr.clips.length; i++) {
        const c = tr.clips[i];
        if (at < c.start + c.dur / 2) { idx = i; break; }
      }
      tr.clips.splice(idx, 0, clip);
      tr.clips.forEach((c, i) => { c.start = i; }); // 순서 고정용 임시값
    }
    packMain(p);
    return tr;
  }
  if (at == null) at = tr.clips.length ? clipEnd(tr.clips[tr.clips.length - 1]) : 0;
  clip.start = Math.max(0, at);
  if (!trackFree(tr, clip.start, clip.dur)) {
    clip.start = tr.clips.length ? Math.max(...tr.clips.map(clipEnd)) : 0;
  }
  tr.clips.push(clip); sortTrack(tr);
  return tr;
}
export function cleanupTracks(p) {
  const counts = {};
  for (const t of p.tracks) counts[t.kind] = (counts[t.kind] || 0) + 1;
  p.tracks = p.tracks.filter((t) => {
    if (t.kind === 'main' || t.clips.length) return true;
    if (counts[t.kind] > 1) { counts[t.kind]--; return false; }
    return true;
  });
}
export function removeClip(p, id) {
  const f = findClip(p, id);
  if (!f) return null;
  f.track.clips.splice(f.index, 1);
  if (f.track.kind === 'main') packMain(p);
  return f;
}
export function splitClip(p, id, t) {
  const f = findClip(p, id);
  if (!f) return null;
  const c = f.clip;
  if (t <= c.start + 1 / FPS - EPS || t >= clipEnd(c) - 1 / FPS + EPS) return null;
  const b = structuredClone(c);
  b.id = uid('c');
  const left = t - c.start;
  c.dur = left;
  b.start = t; b.dur -= left;
  if ('in' in b) b.in = (c.in || 0) + left * (c.speed || 1);
  if ('transition' in c) { b.transition = c.transition; c.transition = null; }
  if (c.anim) { c.anim.out = { type: 'none', dur: c.anim.out.dur }; b.anim.in = { type: 'none', dur: b.anim.in.dur }; }
  if ('fadeOut' in c) { c.fadeOut = 0; b.fadeIn = 0; }
  f.track.clips.splice(f.index + 1, 0, b);
  return b;
}
// 재생헤드 왼쪽(Q)/오른쪽(W) 지우기
export function trimAt(p, id, t, side) {
  const f = findClip(p, id);
  if (!f) return false;
  const c = f.clip;
  if (t <= c.start + EPS || t >= clipEnd(c) - EPS) return false;
  if (side === 'left') {
    const cut = t - c.start;
    c.start = t; c.dur -= cut;
    if ('in' in c) c.in += cut * (c.speed || 1);
    if (c.anim) c.anim.in = { type: 'none', dur: c.anim.in.dur };
  } else {
    c.dur = t - c.start;
    if ('transition' in c) c.transition = null;
  }
  if (f.track.kind === 'main') packMain(p);
  return true;
}
// 속도 등으로 길이가 바뀐 뒤 겹침 정리
export function fixOverlap(p, clip) {
  const f = findClip(p, clip.id);
  if (!f) return;
  if (f.track.kind === 'main') { if (p.magnet) { packMain(p); return; } }
  if (trackFree(f.track, clip.start, clip.dur, clip.id)) return;
  if (f.track.kind === 'main') {
    // 자석 꺼진 메인: 뒤 클립들을 밀어낸다
    sortTrack(f.track);
    let end = clipEnd(clip);
    for (const c of f.track.clips) if (c !== clip && c.start >= clip.start && c.start < end) { c.start = end; end = clipEnd(c); }
    return;
  }
  f.track.clips.splice(f.index, 1);
  placeClip(p, clip, null);
}

// 메인 트랙에서 t 시각에 보이는 장면(전환 포함)
export function transDur(a, b) { return Math.max(0.1, Math.min(a.transition.dur || 0.5, a.dur, b.dur)); }
export function mainSceneAt(p, t) {
  const tr = mainTrack(p);
  if (!tr || tr.hidden) return null;
  const cs = tr.clips.filter((c) => !c.disabled).sort((a, b) => a.start - b.start);
  for (let i = 0; i < cs.length - 1; i++) {
    const A = cs[i], B = cs[i + 1];
    if (A.transition && A.transition.type && Math.abs(B.start - clipEnd(A)) < 1e-3) {
      const d = transDur(A, B), T = clipEnd(A);
      if (t >= T - d / 2 && t < T + d / 2) return { a: A, b: B, type: A.transition.type, p: (t - (T - d / 2)) / d };
    }
  }
  for (const c of cs) if (t >= c.start - EPS && t < clipEnd(c) - EPS) return { a: c };
  return null;
}
// t 시각에 화면에 필요한 영상 클립들
export function videoClipsAt(p, t) {
  const out = [];
  const sc = mainSceneAt(p, t);
  if (sc) { expandVideo(sc.a, out); if (sc.b) expandVideo(sc.b, out); }
  for (const tr of p.tracks) {
    if (tr.kind !== 'overlay' || tr.hidden) continue;
    for (const c of tr.clips) if (!c.disabled && t >= c.start && t < clipEnd(c)) expandVideo(c, out);
  }
  return out;
}
// 메인 트랙의 붙어 있는 경계 목록
export function mainBoundaries(p) {
  const tr = mainTrack(p);
  const cs = [...tr.clips].sort((a, b) => a.start - b.start);
  const out = [];
  for (let i = 0; i < cs.length - 1; i++) if (Math.abs(cs[i + 1].start - clipEnd(cs[i])) < 1e-3) out.push({ a: cs[i], b: cs[i + 1], t: clipEnd(cs[i]) });
  return out;
}
export function clipLabel(c) {
  if (c.type === 'text') return c.text.content.replace(/\n/g, ' ') || '텍스트';
  if (c.type === 'sticker') return c.sticker.emoji;
  if (c.type === 'collage') {
    const n = cellCount(c), filled = (c.collage.cells || []).slice(0, n).filter((x) => x.mediaId && media.has(x.mediaId)).length;
    return `분할 화면 · ${layoutOf(c).name} (${filled}/${n})`;
  }
  return c.name || (media.get(c.mediaId)?.name) || '클립';
}
