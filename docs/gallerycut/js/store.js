// 상태 하나 + 실행취소 스택 + 자동 저장
import { db } from './db.js';
import { newProject, findClip, projectDuration, cleanupTracks } from './model.js';
import { clamp, toast, debounce } from './util.js';

const listeners = new Map();
const mkHist = () => ({ undo: [], redo: [], last: null });

export const store = {
  mode: 'video',
  video: newProject(),
  photo: null,
  sel: null,        // 선택한 클립 id
  selTrans: null,   // 전환이 선택된 클립 id(그 클립 끝의 전환)
  cellSel: null,    // 분할 화면에서 고른 칸 { clipId, idx }
  t: 0,
  playing: false,
  compare: false,   // 원본 비교 중
  hist: { video: mkHist(), photo: mkHist() },
  clipboard: null,
  saveState: 'saved',

  get p() { return this.mode === 'photo' ? this.photo : this.video; },
  on(ev, fn) { if (!listeners.has(ev)) listeners.set(ev, new Set()); listeners.get(ev).add(fn); },
  emit(ev, data) { for (const fn of listeners.get(ev) || []) { try { fn(data); } catch (e) { console.error(e); } } },

  duration() { return this.p ? projectDuration(this.p) : 0; },
  setTime(t, src) {
    const d = this.duration();
    this.t = clamp(t, 0, Math.max(0, d));
    this.emit('time', src);
  },
  select(id, opt = {}) {
    this.sel = id || null;
    if (!opt.keepTrans) this.selTrans = null;
    this.emit('select');
  },
  selectTrans(clipId) { this.sel = null; this.selTrans = clipId; this.emit('select'); },
  selected() { return this.p ? findClip(this.p, this.sel) : null; },

  resetHistory() { const h = this.hist[this.mode]; h.undo = []; h.redo = []; h.last = this.p ? JSON.stringify(this.p) : null; },
  commit(msg, opt = {}) {
    const h = this.hist[this.mode];
    if (!this.p) return;
    cleanupTracks(this.p);
    const s = JSON.stringify(this.p);
    if (s !== h.last) {
      if (h.last) h.undo.push(h.last);
      if (h.undo.length > 120) h.undo.shift();
      h.redo.length = 0;
      h.last = s;
      this.save();
    }
    if (this.sel && !findClip(this.p, this.sel)) this.sel = null;
    if (this.selTrans && !findClip(this.p, this.selTrans)) this.selTrans = null;
    this.emit('project');
    if (this.t > this.duration()) this.setTime(this.duration());
    if (msg) toast(msg, { undoHint: !!opt.undoHint });
  },
  undo() {
    const h = this.hist[this.mode];
    if (!h.undo.length) { toast('더 되돌릴 작업이 없어요'); return; }
    h.redo.push(h.last);
    h.last = h.undo.pop();
    this.replace(JSON.parse(h.last));
    toast('되돌렸어요');
  },
  redo() {
    const h = this.hist[this.mode];
    if (!h.redo.length) { toast('다시 할 작업이 없어요'); return; }
    h.undo.push(h.last);
    h.last = h.redo.pop();
    this.replace(JSON.parse(h.last));
    toast('다시 했어요');
  },
  replace(p) {
    if (this.mode === 'photo') this.photo = p; else this.video = p;
    if (this.sel && !findClip(p, this.sel)) this.sel = null;
    if (this.selTrans && !findClip(p, this.selTrans)) this.selTrans = null;
    this.save();
    this.emit('project');
    this.emit('select');
    if (this.t > this.duration()) this.setTime(this.duration());
  },
  save: null,
};

const doSave = debounce(async () => {
  store.saveState = 'saving'; store.emit('saved');
  const ok1 = await db.put('kv', JSON.stringify(store.video), 'project_video');
  const ok2 = store.photo ? await db.put('kv', JSON.stringify(store.photo), 'project_photo') : true;
  await db.put('kv', store.mode, 'mode');
  store.saveState = ok1 && ok2 ? 'saved' : 'error';
  store.emit('saved');
}, 500);
store.save = () => { store.saveState = 'dirty'; store.emit('saved'); doSave(); };

export async function loadProjects() {
  try {
    const v = await db.get('kv', 'project_video');
    if (v) { const p = JSON.parse(v); if (p && Array.isArray(p.tracks)) store.video = p; }
    const ph = await db.get('kv', 'project_photo');
    if (ph) { const p = JSON.parse(ph); if (p && Array.isArray(p.tracks)) store.photo = p; }
  } catch (e) { console.warn('프로젝트 불러오기 실패', e); }
}
