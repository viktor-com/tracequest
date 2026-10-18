/**
 * Read a file of concatenated zstd frames (DeepSeek Harness appends one frame
 * per write to session.v4.jsonl.zstd). node's zstdDecompressSync stops after
 * the first frame, so the frames are located by walking their headers and
 * block headers, which carry every size needed, and decoded one by one.
 * Skippable frames are stepped over. A frame cut short (a write in progress)
 * or one that fails to decode ends the read with what came before it.
 */
import { closeSync, openSync, readFileSync, readSync } from "node:fs";
import zlib from "node:zlib";

const ZSTD_MAGIC = 0xfd2fb528;
/** Skippable frames use magics 0x184D2A50..0x184D2A5F. */
const SKIPPABLE_MASK = 0xfffffff0;
const SKIPPABLE_MAGIC = 0x184d2a50;
const DICT_ID_BYTES = [0, 1, 2, 4];
const FCS_BYTES = [0, 2, 4, 8];

/** True when this node can decode zstd (zlib.zstdDecompressSync: node 22.15+). */
export function zstdSupported() {
  return typeof zlib.zstdDecompressSync === "function";
}

/**
 * Byte length of the frame starting at `at`, or -1 when it is malformed or
 * extends past the end of `buf`.
 */
export function zstdFrameLength(buf, at) {
  if (at + 4 > buf.length) return -1;
  const magic = buf.readUInt32LE(at);
  if ((magic & SKIPPABLE_MASK) >>> 0 === SKIPPABLE_MAGIC) {
    if (at + 8 > buf.length) return -1;
    const len = 8 + buf.readUInt32LE(at + 4);
    return at + len <= buf.length ? len : -1;
  }
  if (magic !== ZSTD_MAGIC) return -1;
  let p = at + 4;
  if (p >= buf.length) return -1;
  const fhd = buf[p++];
  const fcsFlag = fhd >> 6;
  const singleSegment = (fhd >> 5) & 1;
  const checksum = (fhd >> 2) & 1;
  if (!singleSegment) p++; // window descriptor
  p += DICT_ID_BYTES[fhd & 3];
  p += fcsFlag === 0 ? singleSegment : FCS_BYTES[fcsFlag];
  for (;;) {
    if (p + 3 > buf.length) return -1;
    const header = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
    p += 3;
    const last = header & 1;
    const type = (header >> 1) & 3;
    const size = header >> 3;
    if (type === 3) return -1; // reserved block type
    p += type === 1 ? 1 : size; // an RLE block stores one byte
    if (p > buf.length) return -1;
    if (last) break;
  }
  if (checksum) p += 4;
  return p <= buf.length ? p - at : -1;
}

/** Decoded text of the complete frames in `buf` (at most `maxFrames`), in order. */
export function decodeZstdFrames(buf, maxFrames = Infinity) {
  const parts = [];
  let at = 0;
  while (at < buf.length && parts.length < maxFrames) {
    const len = zstdFrameLength(buf, at);
    if (len < 0) break;
    const magic = buf.readUInt32LE(at);
    if (magic === ZSTD_MAGIC) {
      try {
        parts.push(zlib.zstdDecompressSync(buf.subarray(at, at + len)));
      } catch {
        break;
      }
    }
    at += len;
  }
  return Buffer.concat(parts).toString("utf8");
}

/** A head read is enough for the first few frames (one write each). */
const HEAD_BYTES = 256 * 1024;

/** The first HEAD_BYTES of a file. */
function readHead(filePath) {
  const fd = openSync(filePath, "r");
  try {
    const buf = Buffer.allocUnsafe(HEAD_BYTES);
    return buf.subarray(0, readSync(fd, buf, 0, HEAD_BYTES, 0));
  } finally {
    closeSync(fd);
  }
}

/**
 * The decoded text of a multi-frame zstd file ("" when node has no zstd).
 * With a finite `maxFrames`, only that many frames from the file's head.
 */
export function readZstdFrames(filePath, maxFrames = Infinity) {
  if (!zstdSupported()) return "";
  const buf = Number.isFinite(maxFrames) ? readHead(filePath) : readFileSync(filePath);
  return decodeZstdFrames(buf, maxFrames);
}
