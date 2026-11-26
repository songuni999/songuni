// 포인터로 끌어다 놓기(터치에서도 동작)
import { h } from './util.js';

export function dragSource(el, { ghost, onDrop, onClick, onMove }) {
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('[data-nodrag]')) return;
    const x0 = e.clientX, y0 = e.clientY;
    let g = null;
    const isTouch = e.pointerType === 'touch';
    const move = (ev) => {
      if (!g) {
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < (isTouch ? 14 : 6)) return;
        g = h('div', { class: 'drag-ghost' }, ghost());
        document.body.append(g);
        document.body.classList.add('dragging-item');
      }
      g.style.left = ev.clientX + 'px';
      g.style.top = ev.clientY + 'px';
      onMove?.(ev.clientX, ev.clientY);
    };
    const up = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      if (g) {
        g.remove();
        document.body.classList.remove('dragging-item');
        onDrop?.(ev.clientX, ev.clientY);
      } else onClick?.(ev);
    };
    const cancel = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      if (g) { g.remove(); document.body.classList.remove('dragging-item'); onDrop?.(-1, -1); }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
  });
}
