import {
  copyFileSync,
  cpSync,
  mkdirSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL, fileURLToPath } from "node:url";
import { SRC_HOT_RELOAD_HELPER_DIRS } from "./server-live-reload.js";

const HOT_ENTRY_FILES = ["parse.js", "render.js", "sessions.js"];
const MAX_SNAPSHOTS = 4;

function srcPathFrom(srcDir) {
  return srcDir instanceof URL ? fileURLToPath(srcDir) : srcDir;
}

function cacheRootFor(srcPath) {
  const id = createHash("sha1").update(srcPath).digest("hex").slice(0, 12);
  return join(tmpdir(), "tracequest-hotmodules", `${process.pid}-${id}`);
}

function linkOrCopy(src, dst, dirent) {
  try {
    symlinkSync(src, dst, dirent.isDirectory() ? "dir" : "file");
  } catch {
    if (dirent.isDirectory()) {
      cpSync(src, dst, { recursive: true });
    } else {
      copyFileSync(src, dst);
    }
  }
}

export function createHotModuleSnapshotImporter(srcDir, opts = {}) {
  const srcPath = srcPathFrom(srcDir);
  const cacheRoot = opts.cacheRoot || cacheRootFor(srcPath);
  const maxSnapshots = opts.maxSnapshots || MAX_SNAPSHOTS;
  const copiedDirs = new Set(SRC_HOT_RELOAD_HELPER_DIRS);
  const copiedFiles = new Set(HOT_ENTRY_FILES);
  const snapshots = [];
  let sequence = 0;

  function pruneSnapshots() {
    while (snapshots.length > maxSnapshots) {
      const old = snapshots.shift();
      rmSync(old, { recursive: true, force: true });
    }
  }

  function prepareSnapshot(version) {
    const snapshotRoot = join(cacheRoot, `v${version}-${++sequence}`);
    const snapshotSrc = join(snapshotRoot, basename(srcPath) || "src");

    rmSync(snapshotRoot, { recursive: true, force: true });
    mkdirSync(snapshotSrc, { recursive: true });
    writeFileSync(join(snapshotRoot, "package.json"), "{\"type\":\"module\"}\n");

    for (const dirent of readdirSync(srcPath, { withFileTypes: true })) {
      const from = join(srcPath, dirent.name);
      const to = join(snapshotSrc, dirent.name);
      if (dirent.isDirectory() && copiedDirs.has(dirent.name)) {
        cpSync(from, to, { recursive: true });
      } else if (dirent.isFile() && copiedFiles.has(dirent.name)) {
        copyFileSync(from, to);
      } else {
        linkOrCopy(from, to, dirent);
      }
    }

    snapshots.push(snapshotRoot);
    pruneSnapshots();
    return snapshotSrc;
  }

  return {
    async importEntries(version, entries) {
      const snapshotSrc = prepareSnapshot(version);
      return Promise.all(entries.map((entry) => {
        const url = pathToFileURL(join(snapshotSrc, entry));
        url.searchParams.set("v", `${version}-${sequence}`);
        return import(url.href);
      }));
    },

    reset() {
      rmSync(cacheRoot, { recursive: true, force: true });
      snapshots.length = 0;
    },
  };
}
