// WebM 길이 보정: MediaRecorder가 만든 webm은 머리(Info)에 Duration이 없어 길이가 Infinity로 나온다.
// Segment > Info 안에 Duration을 넣어 준다. (D:\클로드\screen_recorder 의 방식을 옮김)
function ebmlId(b, p) {
  const x = b[p]; if (x === undefined) return null;
  let len = 1, m = 0x80;
  while (len <= 4 && !(x & m)) { m >>= 1; len++; }
  if (len > 4 || p + len > b.length) return null;
  let v = 0; for (let i = 0; i < len; i++) v = v * 256 + b[p + i];
  return { id: v, len };
}
function ebmlSize(b, p) {
  const x = b[p]; if (x === undefined) return null;
  let len = 1, m = 0x80;
  while (len <= 8 && !(x & m)) { m >>= 1; len++; }
  if (len > 8 || p + len > b.length) return null;
  let v = x & (m - 1), all = v === m - 1;
  for (let i = 1; i < len; i++) { v = v * 256 + b[p + i]; if (b[p + i] !== 0xff) all = false; }
  return { size: v, len, unknown: all };
}
function writeVint(out, pos, len, v) {
  for (let i = len - 1; i >= 0; i--) { out[pos + i] = v % 256; v = Math.floor(v / 256); }
  out[pos] |= 1 << (8 - len);
}
function patchWebmDuration(b, ms) {
  const h = ebmlId(b, 0); if (!h || h.id !== 0x1A45DFA3) return null;
  const hs = ebmlSize(b, h.len); if (!hs || hs.unknown) return null;
  let p = h.len + hs.len + hs.size;
  const sg = ebmlId(b, p); if (!sg || sg.id !== 0x18538067) return null;
  const segSizePos = p + sg.len;
  const ss = ebmlSize(b, segSizePos); if (!ss) return null;
  p = segSizePos + ss.len;
  while (p < b.length) {
    const e = ebmlId(b, p); if (!e) return null;
    const s = ebmlSize(b, p + e.len); if (!s) return null;
    const dStart = p + e.len + s.len;
    if (e.id === 0x1F43B675) return null;                 // Info 전에 Cluster가 나오면 포기
    if (e.id === 0x114D9B74) return null;                 // SeekHead가 있으면 위치가 틀어지므로 포기
    if (e.id === 0x1549A966) {                             // Info
      if (s.unknown) return null;
      const dEnd = dStart + s.size; if (dEnd > b.length) return null;
      let scale = 1e6, durPos = -1, durLen = 0, q = dStart;
      while (q < dEnd) {
        const ce = ebmlId(b, q); const cs = ce && ebmlSize(b, q + ce.len); if (!cs) return null;
        const cd = q + ce.len + cs.len;
        if (ce.id === 0x2AD7B1) { let v = 0; for (let i = 0; i < cs.size; i++) v = v * 256 + b[cd + i]; if (v) scale = v; }
        else if (ce.id === 0x4489) { durPos = cd; durLen = cs.size; }
        q = cd + cs.size;
      }
      const dur = ms * 1e6 / scale;
      if (durPos >= 0) {                                   // 이미 있으면 값만 덮어쓰기
        if (durLen !== 4 && durLen !== 8) return null;
        const out = b.slice(); const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
        if (durLen === 8) dv.setFloat64(durPos, dur); else dv.setFloat32(durPos, dur);
        return out;
      }
      // 없으면 Duration(0x4489, 8바이트 float) 새로 넣고 Info 크기를 8바이트 vint로 다시 씀
      const durEl = new Uint8Array(11); durEl[0] = 0x44; durEl[1] = 0x89; durEl[2] = 0x88;
      new DataView(durEl.buffer).setFloat64(3, dur);
      const sizeField = new Uint8Array(8); writeVint(sizeField, 0, 8, s.size + 11);
      const head = b.subarray(0, p + e.len), body = b.subarray(dStart, dEnd), tail = b.subarray(dEnd);
      const out = new Uint8Array(head.length + 8 + body.length + 11 + tail.length);
      let o = 0;
      out.set(head, o); o += head.length; out.set(sizeField, o); o += 8;
      out.set(body, o); o += body.length; out.set(durEl, o); o += 11; out.set(tail, o);
      if (!ss.unknown) {                                   // Segment 크기가 정해져 있으면 함께 늘려 줌
        const nv = ss.size + (8 - s.len) + 11;
        if (nv >= Math.pow(2, 7 * ss.len) - 1) return null;
        writeVint(out, segSizePos, ss.len, nv);
      }
      return out;
    }
    if (s.unknown) return null;
    p = dStart + s.size;
  }
  return null;
}
export async function fixWebmDuration(blob, ms) {
  const n = Math.min(blob.size, 1 << 20);
  const head = new Uint8Array(await blob.slice(0, n).arrayBuffer());
  const out = patchWebmDuration(head, ms);
  return out ? new Blob([out, blob.slice(n)], { type: blob.type }) : blob;
}
