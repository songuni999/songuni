// 첫 실행 3단계 안내
import { h, safeLocal } from './util.js';

const KEY = 'nyangcut_tour_done';
const STEPS_PC = [
  { sel: '#import-box', title: '1. 가져오기', text: '이 ＋ 상자를 눌러 사진·영상·음악을 고르세요. 파일을 화면 아무 데나 끌어다 놓아도 돼요.' },
  { sel: '#bottom', title: '2. 타임라인에서 편집', text: '가져온 파일이 여기 줄줄이 놓여요. 클립을 눌러 고르고, 끌어서 옮기고, 양 끝을 끌어 길이를 줄여요. 자르기는 Ctrl+B.' },
  { sel: '#btn-export', title: '3. 내보내기', text: '다 만들었으면 이 버튼! MP4 파일로 저장돼요. 작업은 자동 저장되니 창을 닫아도 그대로예요.' },
];
// 폰 배치용 3단계
const STEPS_M = [
  { sel: '#m-add', title: '1. ＋로 추가', text: '가운데 ＋ 버튼을 누르면 폰 갤러리가 열려요. 고른 사진·영상이 타임라인 끝에 붙어요.' },
  { sel: '#m-tools', title: '2. 아래 도구로 편집', text: '타임라인을 손가락으로 밀면 시간이 움직여요. 클립을 톡 누르면 아래 도구가 그 클립용으로 바뀌고, 길게 누르면 옮길 수 있어요. 두 손가락으로 벌리면 확대돼요.' },
  { sel: '#m-export', title: '3. 내보내기', text: '다 만들었으면 이 버튼! 끝나면 "갤러리에 저장"으로 사진 앱에 넣을 수 있어요. 작업은 이 기기에 자동 저장돼요.' },
];

export function startTour(force) {
  if (!force && safeLocal(KEY) === '1') return;
  let i = 0;
  const STEPS = document.body.classList.contains('m') ? STEPS_M : STEPS_PC;
  const hole = h('div', { class: 'tour-hole' });
  const title = h('b', null), text = h('p', null);
  const never = h('input', { type: 'checkbox', checked: true });
  const nextBtn = h('button', { class: 'pbtn primary' }, '다음');
  const card = h('div', { class: 'tour-card', role: 'dialog', 'aria-label': '사용 안내' },
    h('div', { class: 'tour-step' }), title, text,
    h('label', { class: 'tour-never' }, never, '다시 보지 않기'),
    h('div', { class: 'tour-btns' }, h('button', { class: 'pbtn', onclick: () => end() }, '건너뛰기'), nextBtn));
  const wrap = h('div', { class: 'tour' }, hole, card);
  document.body.append(wrap);
  nextBtn.addEventListener('click', () => { i++; if (i >= STEPS.length) end(); else show(); });
  const onResize = () => show();
  window.addEventListener('resize', onResize);
  function show() {
    if (!wrap.isConnected) { window.removeEventListener('resize', onResize); return; }
    const s = STEPS[i];
    const el = document.querySelector(s.sel);
    card.querySelector('.tour-step').textContent = `${i + 1} / ${STEPS.length}`;
    title.textContent = s.title; text.textContent = s.text;
    nextBtn.textContent = i === STEPS.length - 1 ? '시작하기' : '다음';
    const r = el ? el.getBoundingClientRect() : null;
    if (!el || r.right < 0 || r.left > window.innerWidth || !r.width) { hole.style.display = 'none'; Object.assign(card.style, { left: Math.max(10, (window.innerWidth - Math.min(320, window.innerWidth - 20)) / 2) + 'px', top: '30%', width: Math.min(320, window.innerWidth - 20) + 'px' }); return; }
    hole.style.display = 'block';
    Object.assign(hole.style, { left: r.left - 6 + 'px', top: r.top - 6 + 'px', width: r.width + 12 + 'px', height: r.height + 12 + 'px' });
    const cw = Math.min(320, window.innerWidth - 20);
    let cx = r.left + r.width / 2 - cw / 2, cy = r.bottom + 16;
    if (cy + 220 > window.innerHeight) cy = Math.max(10, r.top - 230);
    cx = Math.max(10, Math.min(window.innerWidth - cw - 10, cx));
    Object.assign(card.style, { left: cx + 'px', top: cy + 'px', width: cw + 'px' });
  }
  function end() {
    if (never.checked) safeLocal(KEY, '1');
    window.removeEventListener('resize', onResize);
    wrap.remove();
  }
  show();
}
