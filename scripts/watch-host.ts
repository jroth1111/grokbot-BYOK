/**
 * Bundle watcher (replaces watch-inference-patch.sh).
 *
 * Watches host-main.cjs for changes. When the file changes (e.g. the host is
 * reinstalled/updated by the supervisor), it checks whether the routing-client
 * patch is still present. If not, it re-applies the patch via patch-host.ts and
 * restarts the host process (kill + supervisor restart).
 *
 * Uses fs.watch when available; falls back to 5s polling otherwise.
 *
 * Env vars:
 *   SAND_HOST_DIR  Directory containing host-main.cjs (default: ~/sand-host)
 */
import { existsSync, readFileSync, statSync, watch } from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/log.js";

const log = createLogger();

const PATCH_MARKER = "routingClient";

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

/** Handle a detected change: check patch, re-apply if missing, restart host. */
async function handleChange(filePath: string, projectRoot: string): Promise<void> {
  log.info("watch-host: change detected", { path: filePath });
  if (!existsSync(filePath)) {
    log.warn("watch-host: file gone, waiting for it to reappear", { path: filePath });
    return;
  }
  if (isPatched(filePath)) {
    log.info("watch-host: patch still present, nothing to do");
    return;
  }
  log.warn("watch-host: patch missing, re-applying");
  if (reapplyPatch(projectRoot)) {
    log.info("watch-host: restarting host");
    restartHost();
    await sleep(2000);
  }
}

/** Polling fallback: stat the file every `intervalMs` and compare mtime. */
async function poll(filePath: string, projectRoot: string, intervalMs: number): Promise<void> {
  log.info("watch-host: polling fallback active", { intervalMs });
  let lastMtime = existsSync(filePath) ? statSync(filePath).mtimeMs : 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await sleep(intervalMs);
    if (!existsSync(filePath)) {
      continue;
    }
    let mtime: number;
    try {
      mtime = statSync(filePath).mtimeMs;
    } catch {
      continue;
    }
    if (mtime !== lastMtime) {
      lastMtime = mtime;
      await handleChange(filePath, projectRoot);
    }
  }
}

function main(): void {
  const config = loadConfig();
  const sandHostDir =
    process.env.SAND_HOST_DIR || config.hostConfig.sandHostDir || path.join(process.env.HOME ?? "/root", "sand-host");
  const projectRoot = process.cwd();
  const hostMainPath = path.join(sandHostDir, "host-main.cjs");

  if (!existsSync(hostMainPath)) {
    log.error("watch-host: host-main.cjs not found", { path: hostMainPath });
    process.exit(1);
  }

  log.info("watch-host: watching host-main.cjs", { path: hostMainPath });

  let watcher: ReturnType<typeof watch> | null = null;
  try {
    watcher = watch(hostMainPath, { persistent: true });
  } catch (err) {
    log.warn("watch-host: fs.watch unavailable, using polling", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (watcher) {
    let debounce: NodeJS.Timeout | null = null;
    watcher.on("change", (_event, filename) => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        void handleChange(hostMainPath, projectRoot);
      }, 500);
    });
    watcher.on("error", (err) => {
      log.error("watch-host: watcher error", { error: err.message });
    });
    // Keep the process alive.
    setInterval(() => {}, 1 << 30);
  } else {
    void poll(hostMainPath, projectRoot, 5000);
  }
}

main();
