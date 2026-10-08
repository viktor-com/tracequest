/** Numeric mtime for stable descending sort (Date, epoch ms, or missing). */
export function sessionMtimeMs(s) {
  const m = s?.mtime;
  if (m instanceof Date) return m.getTime() || 0;
  if (typeof m === "number" && Number.isFinite(m)) return m;
  return 0;
}

export function sortSessionsByMtimeDesc(sessions) {
  return sessions.sort((a, b) => sessionMtimeMs(b) - sessionMtimeMs(a));
}

/** XOR checksum over session mtime, size, and path hints (shared by index and browser page caches). */
export function sessionListChecksum(sessions) {
  let checksum = 0;
  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    checksum ^= sessionMtimeMs(s);
    checksum ^= s.size || 0;
    const p = s.path;
    checksum ^= p.length;
    if (p.length > 0) checksum ^= p.charCodeAt(0);
    if (p.length > 4) checksum ^= p.charCodeAt(p.length - 1);
  }
  return checksum;
}