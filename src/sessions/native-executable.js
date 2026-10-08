import { closeSync, openSync, readSync } from "node:fs";

/**
 * Leading bytes of every executable format cargo emits on a supported host.
 * The sidecar gate keyed on ELF alone until 2026-07, so a macOS-built sidecar
 * was rejected as invalid and every run silently fell back to the JS indexer.
 */
const MAGICS = [
  [0x7f, 0x45, 0x4c, 0x46], // ELF — Linux
  [0xfe, 0xed, 0xfa, 0xce], // Mach-O 32-bit BE
  [0xfe, 0xed, 0xfa, 0xcf], // Mach-O 64-bit BE
  [0xce, 0xfa, 0xed, 0xfe], // Mach-O 32-bit LE
  [0xcf, 0xfa, 0xed, 0xfe], // Mach-O 64-bit LE — macOS arm64/x64
  [0xca, 0xfe, 0xba, 0xbe], // Mach-O universal
  [0x4d, 0x5a], // PE/COFF "MZ" — Windows
];

/** Mach-O cpu_type_t, low 24 bits (high byte is the 64-bit ABI flag). */
const MACHO_CPU = { 7: "x64", 12: "arm64" };
/** ELF e_machine. */
const ELF_MACHINE = { 0x3e: "x64", 0xb7: "arm64" };

function readHead(filePath, length, onReadError) {
  let fd;
  try {
    fd = openSync(filePath, "r");
    const buf = Buffer.alloc(length);
    const read = readSync(fd, buf, 0, length, 0);
    return { buf, read };
  } catch (err) {
    onReadError?.(err);
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** True when filePath begins with the magic bytes of a native executable. */
export function isNativeExecutable(filePath, onReadError) {
  const head = readHead(filePath, 4, onReadError);
  if (!head) return false;
  return MAGICS.some(
    (magic) => magic.length <= head.read && magic.every((byte, i) => head.buf[i] === byte),
  );
}

/**
 * Read the executable's real CPU architecture from its header.
 *
 * Magic bytes identify the format but not the architecture: an arm64 and an
 * x86_64 Mach-O share the same first four bytes. Without this, a mislabeled
 * build artifact would be staged under the wrong platform directory and
 * degrade that platform to the JS indexer with no error.
 *
 * Returns `{ format, arch }`, or null if the file is not a recognized
 * single-architecture native executable. Universal (fat) binaries return
 * arch `null` — they carry several architectures and need no platform dir.
 */
export function readExecutableTarget(filePath, onReadError) {
  const head = readHead(filePath, 20, onReadError);
  if (!head || head.read < 20) return null;
  const { buf } = head;

  // Mach-O 64-bit little-endian: magic cffaedfe, cputype at offset 4 (LE).
  if (buf[0] === 0xcf && buf[1] === 0xfa && buf[2] === 0xed && buf[3] === 0xfe) {
    const cpu = buf.readUInt32LE(4) & 0x00ffffff;
    return { format: "macho", arch: MACHO_CPU[cpu] ?? null };
  }
  // Mach-O universal (fat): several slices, no single arch.
  if (buf[0] === 0xca && buf[1] === 0xfe && buf[2] === 0xba && buf[3] === 0xbe) {
    return { format: "macho-universal", arch: null };
  }
  // ELF: e_machine is a 16-bit field at offset 0x12; only little-endian hosts.
  if (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) {
    return { format: "elf", arch: ELF_MACHINE[buf.readUInt16LE(0x12)] ?? null };
  }
  if (buf[0] === 0x4d && buf[1] === 0x5a) return { format: "pe", arch: null };
  return null;
}
