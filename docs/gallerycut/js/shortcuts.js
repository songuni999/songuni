// 단축키 + 단축키 표
import { store } from './store.js';
import { h, isTyping, FPS, toast } from './util.js';
import { icon } from './icons.js';
import * as act from './actions.js';
import { getPlayer } from './preview.js';
import { tl } from './timeline.js';
import { toggleScreenRecord } from './screenrec.js';

export const KEYS = [
  ['Space', '재생 / 정지'],
  ['Ctrl + B', '분할(재생헤드 위치에서 자르기)'],
  ['Ctrl + Shift + B', '모든 트랙 한꺼번에 분할'],
  ['Delete / Backspace', '고른 클립(또는 전환) 삭제'],
  ['Q', '재생헤드 왼쪽 부분 지우기'],
  ['W', '재생헤드 오른쪽 부분 지우기'],
  ['Ctrl + Z', '실행취소'],
  ['Ctrl + Shift + Z / Ctrl + Y', '다시 실행'],
  ['Ctrl + C / Ctrl + V', '클립 복사 / 붙여넣기(재생헤드 위치)'],
  ['Ctrl + D', '클립 복제'],
  ['← / →', '1프레임 뒤로 / 앞으로'],
  ['Shift + ← / →', '1초 뒤로 / 앞으로'],
  ['Home / End', '맨 처음 / 맨 끝으로'],
  ['+ / -', '타임라인 확대 / 축소 (Ctrl + 마우스 휠도 돼요)'],
  ['V', '고른 클립 켜기 / 끄기'],
  ['Ctrl + Shift + R', '화면 녹화 시작 / 정지'],
  ['Esc', '선택 해제'],
];

export function initShortcuts() {
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === 'KeyR') { e.preventDefault(); document.querySelector('.modal-back')?.remove(); toggleScreenRecord(); return; }
    if (document.querySelector('.modal-back')) { if (e.key === 'Escape') document.querySelector('.modal-back')?.remove(); return; }
    if (isTyping(e.target)) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key;
    const video = store.mode === 'video';
    let done = true;
    if (k === ' ' || e.code === 'Space') { if (video) getPlayer().toggle(); }
    else if (ctrl && (k === 'b' || k === 'B') && e.shiftKey) act.splitAll();
    else if (ctrl && (k === 'b' || k === 'B')) act.split();
    else if (ctrl && (k === 'z' || k === 'Z') && e.shiftKey) store.redo();
    else if (ctrl && (k === 'z' || k === 'Z')) store.undo();
    else if (ctrl && (k === 'y' || k === 'Y')) store.redo();
    else if (ctrl && (k === 'c' || k === 'C')) act.copy();
    else if (ctrl && (k === 'v' || k === 'V')) act.paste();
    else if (ctrl && (k === 'd' || k === 'D')) act.duplicate();
    else if (ctrl) done = false;
    else if (k === 'Delete' || k === 'Backspace') act.del();
    else if (k === 'q' || k === 'Q' || k === 'ㅂ') act.trimSide('left');
    else if (k === 'w' || k === 'W' || k === 'ㅈ') act.trimSide('right');
    else if (k === 'v' || k === 'V' || k === 'ㅍ') act.toggleClip();
    else if (k === 'ArrowLeft') store.setTime(store.t - (e.shiftKey ? 1 : 1 / FPS));
    else if (k === 'ArrowRight') store.setTime(store.t + (e.shiftKey ? 1 : 1 / FPS));
    else if (k === 'Home') store.setTime(0);
    else if (k === 'End') store.setTime(store.duration());
    else if (k === '+' || k === '=') { if (video) tl.zoomBy(1.4); }
    else if (k === '-' || k === '_') { if (video) tl.zoomBy(1 / 1.4); }
    else if (k === 'Escape') store.select(null);
    else if (k === '?') openKeys();
    else done = false;
    if (done) e.preventDefault();
  });
}

export function openKeys() {
  const close = () => dlg.remove();
  const dlg = h('div', { class: 'modal-back', onclick: (e) => { if (e.target === dlg) close(); } },
    h('div', { class: 'modal keys-modal', role: 'dialog', 'aria-label': '단축키' },
      h('div', { class: 'modal-head' }, h('b', null, '단축키 표'), h('button', { class: 'ibtn', onclick: close, 'aria-label': '닫기' }, icon('close'))),
      h('table', { class: 'keys' }, h('tbody', null, KEYS.map(([k, d]) => h('tr', null, h('td', null, k.split(' / ').map((x, i) => [i ? ' / ' : '', h('kbd', null, x)])), h('td', null, d))))),
      h('p', { class: 'note' }, '글을 입력하는 칸에 있을 때는 단축키가 작동하지 않아요.'),
      h('div', { class: 'modal-foot' },
        h('button', { class: 'pbtn', onclick: () => { close(); import('./onboard.js').then((m) => m.startTour(true)); } }, '처음 안내 다시 보기'),
        h('button', { class: 'pbtn primary', onclick: close }, '알겠어요'))));
  document.body.append(dlg);
}
export { toast };
