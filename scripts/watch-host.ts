/**
 * Bundle watcher (replaces watch-inference-patch.sh).
 *
 * Watches host-main.cjs for changes. When the file changes (e.g. the host is
 * reinstalled/updated by the supervisor), it checks whether the routing-client
 * patch is still present. If not, it re-applies the patch via patch-host.ts and
 * restarts the host process (kill + supervisor restart).
 *
 * Uses fs.watch when available; falls back to 5s polling otherwise. fs.watch
 * follows the file's inode, so an atomic replace (temp file + rename, which is
 * how the supervisor installs updates) makes the watcher stale after a single
 * 'rename' event. We therefore re-arm the watcher on 'rename'/'error' and fall
 * back to polling if re-arming keeps failing.
 *
 * Env vars:
 *   SAND_HOST_DIR  Directory containing host-main.cjs (default: ~/sand-host)
 */
import { existsSync, readFileSync, statSync, watch, type FSWatcher } from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/log.js";
import { resolveSandHostDir } from "../src/utils/daemon.js";

const log = createLogger();

const PATCH_MARKER = "routingClient";

/** Re-arm retry cap before giving up on fs.watch and switching to polling. */
const REARM_MAX_ATTEMPTS = 5;
const REARM_DELAY_MS = 1000;
/** Settle window so a non-atomic write can finish before we read. */
const SETTLE_DELAY_MS = 300;
/** How long to wait for the file content to stop changing between reads. */
const STABLE_PROBE_DELAY_MS = 150;
const STABLE_PROBE_TRIES = 5;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Read the file, returning the content or null. */
function readFileSafe(filePath: string): string | null {
  if (!existsSync(filePath)) return null;
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

/**
 * Read the file only once its content has stopped changing. A non-atomic
 * (truncate-then-write) update can fire the change event mid-write; reading at
 * that point yields a truncated file which we would then mistake for an
 * unpatched host. We sample repeatedly until two consecutive reads match.
 */
async function readStable(filePath: string): Promise<string | null> {
  let prev = readFileSafe(filePath);
  for (let i = 0; i < STABLE_PROBE_TRIES; i++) {
    await sleep(STABLE_PROBE_DELAY_MS);
    const cur = readFileSafe(filePath);
    if (cur === prev) return cur;
    prev = cur;
  }
  return prev;
}

/** True if the patch marker is present in host-main.cjs. */
function isPatched(filePath: string): boolean {
  const src = readFileSafe(filePath);
  return src !== null && src.includes(PATCH_MARKER);
}

/** Re-apply the patch via the built patch-host.js script. */
function reapplyPatch(projectRoot: string): boolean {
  try {
    execSync("node dist/scripts/patch-host.js", { stdio: "inherit", cwd: projectRoot });
    return true;
  } catch (err) {
    log.error("watch-host: patch re-apply failed", { error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

/** Kill the host-main.cjs process; supervisor restarts it. Best-effort. */
function restartHost(): void {
  try {
    execSync('pkill -f "host-main.cjs"', { stdio: "ignore" });
  } catch {
    /* no matching process */
  }
}

// Re-entrancy guard: handleChange is async and a second change event can fire
// while the first is still running. Without a guard, two concurrent patch
// re-applies race on writeFileSync and can corrupt the bundle.
let busy = false;
let pending = false;

/** Handle a detected change: check patch, re-apply if missing, restart host. */
async function handleChange(filePath: string, projectRoot: string): Promise<void> {
  if (busy) {
    // Coalesce: remember that another change happened during our work and
    // re-run once we're done.
    pending = true;
    return;
  }
  busy = true;
  try {
    log.info("watch-host: change detected", { path: filePath });
    // Let any in-flight write finish before inspecting the file.
    await sleep(SETTLE_DELAY_MS);
    const src = await readStable(filePath);
    if (src === null) {
      log.warn("watch-host: file gone, waiting for it to reappear", { path: filePath });
      return;
    }
    if (src.includes(PATCH_MARKER)) {
      log.info("watch-host: patch still present, nothing to do");
      return;
    }
    log.warn("watch-host: patch missing, re-applying");
    if (reapplyPatch(projectRoot)) {
      // Verify the patch actually landed before restarting; reapplyPatch
      // returning true only means the subprocess exited 0.
      if (isPatched(filePath)) {
        log.info("watch-host: restarting host");
        restartHost();
        await sleep(2000);
      } else {
        log.error("watch-host: patch re-apply reported success but marker is missing", { path: filePath });
      }
    }
  } finally {
    busy = false;
    if (pending) {
      pending = false;
      void handleChange(filePath, projectRoot);
    }
  }
}

/** Polling fallback: stat the file every `intervalMs` and compare mtime. */
async function poll(filePath: string, projectRoot: string, intervalMs: number): Promise<void> {
  log.info("watch-host: polling fallback active", { intervalMs });
  let lastMtime = safeMtime(filePath);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await sleep(intervalMs);
    const mtime = safeMtime(filePath);
    if (mtime === null) {
      // File is gone. Reset so any reappearance is detected even when the new
      // file has an equal/older mtime (e.g. copy with preserved mtime).
      if (lastMtime !== 0) lastMtime = 0;
      continue;
    }
    if (mtime !== lastMtime) {
      lastMtime = mtime;
      await handleChange(filePath, projectRoot);
    }
  }
}

/** stat mtimeMs, or null if the file is missing/stat fails. */
function safeMtime(filePath: string): number | null {
  if (!existsSync(filePath)) return null;
  try {
    return statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}

function main(): void {
  const config = loadConfig();
  const sandHostDir = resolveSandHostDir(config);
  const projectRoot = process.cwd();
  const hostMainPath = path.join(sandHostDir, "host-main.cjs");

  if (!existsSync(hostMainPath)) {
    log.error("watch-host: host-main.cjs not found", { path: hostMainPath });
    process.exit(1);
  }

  log.info("watch-host: watching host-main.cjs", { path: hostMainPath });

  let watcher: FSWatcher | null = null;
  let debounce: NodeJS.Timeout | null = null;
  let rearmAttempts = 0;
  let polling = false;

  /** (Re)create the fs.watch watcher. Falls back to polling after repeated failures. */
  function armWatcher(): void {
    if (polling) return;
    try {
      watcher = watch(hostMainPath, { persistent: true });
      rearmAttempts = 0;
    } catch (err) {
      rearmAttempts += 1;
      log.warn("watch-host: fs.watch failed to arm", {
        attempt: rearmAttempts,
        error: err instanceof Error ? err.message : String(err),
      });
      if (rearmAttempts >= REARM_MAX_ATTEMPTS) {
        log.warn("watch-host: giving up on fs.watch, switching to polling");
        polling = true;
        void poll(hostMainPath, projectRoot, 5000);
      } else {
        setTimeout(armWatcher, REARM_DELAY_MS);
      }
      return;
    }

    watcher.on("change", (event) => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        debounce = null;
        void handleChange(hostMainPath, projectRoot);
      }, 500);

      // 'rename' means the inode we are watching was replaced (atomic update).
      // The current watcher is now watching a stale/unlinked inode and will
      // never fire again, so close it and re-arm on the path (new inode).
      if (event === "rename") {
        watcher?.close();
        watcher = null;
        setTimeout(armWatcher, REARM_DELAY_MS);
      }
    });
    watcher.on("error", (err) => {
      log.error("watch-host: watcher error, re-arming", { error: err.message });
      watcher?.close();
      watcher = null;
      rearmAttempts += 1;
      if (rearmAttempts >= REARM_MAX_ATTEMPTS) {
        log.warn("watch-host: giving up on fs.watch, switching to polling");
        polling = true;
        void poll(hostMainPath, projectRoot, 5000);
      } else {
        setTimeout(armWatcher, REARM_DELAY_MS);
      }
    });
  }

  armWatcher();
  // Keep the process alive (the polling loop is self-keeping, this is a no-op
  // for the fs.watch branch).
  setInterval(() => {}, 1 << 30);
}

main();
