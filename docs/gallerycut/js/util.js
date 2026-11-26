// 갤러리컷 공용 도구
export const FPS = 30;
export const MAX_TEXT = 500;
export const MAX_NAME = 50;

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const uid = (p = 'id') => p + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

// 안전한 요소 생성기: 글자는 항상 텍스트 노드로 들어간다(innerHTML 안 씀).
// 'svg' 속성만 예외로, 코드에 박힌 아이콘 상수만 넣는다.
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'svg') el.innerHTML = v; // 신뢰된 아이콘 상수 전용
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else if (k === 'text') el.textContent = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const c of kids.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const pad = (n, l = 2) => String(n).padStart(l, '0');
export function fmtTime(t) {
  const f = Math.max(0, Math.round((t || 0) * FPS));
  const mm = Math.floor(f / (60 * FPS));
  const ss = Math.floor(f / FPS) % 60;
  const ff = f % FPS;
  return `${pad(mm)}:${pad(ss)}:${pad(ff)}`;
}
export function fmtDur(t) {
  t = Math.max(0, t || 0);
  const m = Math.floor(t / 60), s = t - m * 60;
  if (m > 0) return `${m}:${pad(Math.floor(s))}`;
  return s < 10 ? `${s.toFixed(1)}초` : `${Math.round(s)}초`;
}
export function stamp() {
  const d = new Date();
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
export function fmtBytes(n) {
  if (n > 1 << 30) return (n / (1 << 30)).toFixed(2) + 'GB';
  if (n > 1 << 20) return (n / (1 << 20)).toFixed(1) + 'MB';
  return Math.max(1, Math.round(n / 1024)) + 'KB';
}
export function debounce(fn, ms) {
  let id;
  return (...a) => { clearTimeout(id); id = setTimeout(() => fn(...a), ms); };
}
export function cleanText(s, max = MAX_TEXT) {
  return String(s ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').slice(0, max);
}
export function safeLocal(key, val) {
  try {
    if (val === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, val);
  } catch (e) { return null; }
  return null;
}

// 알림(토스트)
let toastBox;
export function toast(msg, opt = {}) {
  toastBox ||= document.getElementById('toasts');
  if (!toastBox) return;
  const t = h('div', { class: 'toast' + (opt.type ? ' ' + opt.type : '') }, h('span', null, msg));
  if (opt.action) {
    t.append(h('button', { class: 'toast-act', onclick: () => { opt.action.fn(); t.remove(); } }, opt.action.label));
  } else if (opt.undoHint) {
    t.append(h('span', { class: 'toast-hint' }, document.body.classList.contains('m') ? '위 ↶ 로 되돌리기' : '되돌리기 Ctrl+Z'));
  }
  toastBox.append(t);
  while (toastBox.children.length > 3) toastBox.firstChild.remove();
  setTimeout(() => t.classList.add('out'), opt.ms || 2600);
  setTimeout(() => t.remove(), (opt.ms || 2600) + 400);
}

export function download(blob, name) {
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
}

export const easeOut = (e) => 1 - Math.pow(1 - e, 3);
export const easeInOut = (e) => (e < 0.5 ? 4 * e * e * e : 1 - Math.pow(-2 * e + 2, 3) / 2);
export const backOut = (e) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(e - 1, 3) + c1 * Math.pow(e - 1, 2); };

export function isTyping(target) {
  if (!target) return false;
  const tag = target.tagName;
  if (target.isContentEditable) return true;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const ty = (target.type || '').toLowerCase();
    return !['range', 'checkbox', 'radio', 'button', 'color', 'file'].includes(ty);
  }
  return false;
}
