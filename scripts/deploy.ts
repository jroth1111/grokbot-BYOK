/**
 * Atomic deploy script (replaces deploy.sh).
 *
 * Runs the full deploy pipeline:
 *   1. Syntax check (tsc --noEmit)
 *   2. Build (npm run build:all)
 *   3. Stop the old shim
 *   4. Deploy the new shim (symlink or copy)
 *   5. Start the new shim and wait for the port to listen
 *   6. Re-apply the host patch
 *   7. Restart the host process
 *   8. Smoke test (health-check)
 *
 * CLI flags:
 *   --copy        Copy dist/shim.js instead of symlinking.
 *   --no-restart  Skip the host restart step.
 *   --no-test     Skip the smoke test step.
 *
 * Env vars (override config):
 *   SAND_HOST_DIR  Directory containing host-main.cjs (default: ~/sand-host)
 *   SHIM_PORT      Port the shim listens on (default: from config)
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync, copyFileSync, symlinkSync, renameSync } from "node:fs";
import * as path from "node:path";
import * as net from "node:net";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/log.js";

const log = createLogger();

/** Parse the simple boolean CLI flags from process.argv. */
function parseArgs(argv: string[]): { copy: boolean; noRestart: boolean; noTest: boolean } {
  return {
    copy: argv.includes("--copy"),
    noRestart: argv.includes("--no-restart"),
    noTest: argv.includes("--no-test"),
  };
}

/** Run a shell command, throwing on failure. Output is inherited. */
function run(cmd: string, opts?: { cwd?: string }): void {
  execSync(cmd, { stdio: "inherit", cwd: opts?.cwd });
}

/** Sleep for ms milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Attempt a TCP connect to host:port. Resolves true on success. */
function portIsListening(host: string, port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const cleanup = (ok: boolean) => {
      sock.removeAllListeners();
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => cleanup(true));
    sock.once("timeout", () => cleanup(false));
    sock.once("error", () => cleanup(false));
  });
}

/** Kill a process by PID file, then pkill by pattern. Best-effort. */
async function stopOldShim(pidFile: string): Promise<void> {
  if (existsSync(pidFile)) {
    let pid: number | undefined;
    try {
      const parsed = parseInt(readFileSync(pidFile, "utf8").trim(), 10);
      if (!Number.isNaN(parsed)) pid = parsed;
    } catch {
      /* ignore read errors */
    }
    if (pid !== undefined) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* already dead */
      }
      // Wait up to 5s for graceful exit, then SIGKILL if still alive.
      for (let i = 0; i < 50; i++) {
        try {
          process.kill(pid, 0);
        } catch {
          break; // process has exited
        }
        await sleep(100);
      }
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already dead */
      }
    }
  }
  try {
    execSync('pkill -f "dist/shim.js"', { stdio: "ignore" });
  } catch {
    /* no matching process */
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();

  // SCRIPT_DIR = directory of the *built* script (dist/scripts).
  // Derive projectRoot from the script location so the deploy works
  // regardless of the caller's working directory.
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const distDir = path.resolve(scriptDir, "..");
  const projectRoot = path.resolve(distDir, "..");
  const sandHostDir = process.env.SAND_HOST_DIR || config.hostConfig.sandHostDir || path.join(process.env.HOME ?? "/root", "sand-host");
  const shimPort = parseInt(process.env.SHIM_PORT ?? String(config.port), 10);
  if (Number.isNaN(shimPort) || shimPort <= 0 || shimPort > 65535) {
    log.error("deploy: invalid shim port", { port: process.env.SHIM_PORT ?? config.port });
    process.exit(1);
  }
  const shimHost = config.host || "127.0.0.1";
  const pidFile = "/tmp/inference-shim.pid";
  const logFile = "/tmp/inference-shim.log";

  const shimBuilt = path.join(distDir, "shim.js");
  const deployTarget = path.join(sandHostDir, "inference-shim.cjs");

  // Step 1: syntax check
  log.info("deploy: step 1/8 syntax check");
  try {
    run("npx tsc --noEmit", { cwd: projectRoot });
  } catch {
    log.error("deploy: syntax check failed");
    process.exit(1);
  }

  // Step 2: build
  log.info("deploy: step 2/8 build");
  try {
    run("npm run build:all", { cwd: projectRoot });
  } catch {
    log.error("deploy: build failed");
    process.exit(1);
  }

  // Step 3: stop old shim
  log.info("deploy: step 3/8 stop old shim");
  await stopOldShim(pidFile);
  // Brief pause for the OS to release the listening socket.
  await sleep(500);

  // Step 4: deploy (symlink or copy) — atomic via temp file + rename.
  log.info("deploy: step 4/8 deploy shim", { copy: args.copy, target: deployTarget });
  const tmpTarget = `${deployTarget}.${process.pid}.tmp`;
  try {
    // Clean up any stale temp file from a previous failed run.
    try {
      unlinkSync(tmpTarget);
    } catch {
      /* not present */
    }
    if (args.copy) {
      copyFileSync(shimBuilt, tmpTarget);
    } else {
      // Relative symlink so the link survives repo moves.
      const linkTarget = path.relative(path.dirname(deployTarget), shimBuilt);
      symlinkSync(linkTarget, tmpTarget);
    }
    // Atomically replace the deploy target (POSIX rename).
    renameSync(tmpTarget, deployTarget);
  } catch (err) {
    // Clean up the temp file on failure.
    try {
      unlinkSync(tmpTarget);
    } catch {
      /* ignore */
    }
    log.error("deploy: failed to deploy shim", { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  }

  // Step 5: start new shim
  log.info("deploy: step 5/8 start new shim", { port: shimPort });
  try {
    const child = execSync(
      `nohup node ${JSON.stringify(shimBuilt)} > ${JSON.stringify(logFile)} 2>&1 & echo $!`,
      { cwd: projectRoot },
    );
    const pid = parseInt(child.toString().trim(), 10);
    if (!Number.isNaN(pid)) {
      writeFileSync(pidFile, String(pid));
    }
  } catch (err) {
    log.error("deploy: failed to start shim", { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  }

  // Wait up to 10s for the port to listen.
  let listening = false;
  for (let i = 0; i < 10; i++) {
    if (await portIsListening(shimHost, shimPort)) {
      listening = true;
      break;
    }
    await sleep(1000);
  }
  if (!listening) {
    log.error("deploy: shim did not start listening in time", { port: shimPort });
    process.exit(1);
  }
  log.info("deploy: shim is listening", { port: shimPort });

  // Step 6: re-apply host patch
  log.info("deploy: step 6/8 re-apply host patch");
  try {
    run("node dist/scripts/patch-host.js", { cwd: projectRoot });
  } catch (err) {
    log.error("deploy: host patch failed", { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  }

  // Step 7: restart host
  if (!args.noRestart) {
    log.info("deploy: step 7/8 restart host");
    restartHost();
    // Give the supervisor a moment to restart it.
    await sleep(2000);
  } else {
    log.info("deploy: step 7/8 restart host (skipped via --no-restart)");
  }

  // Step 8: smoke test
  if (!args.noTest) {
    log.info("deploy: step 8/8 smoke test");
    try {
      run("node dist/scripts/health-check.js", { cwd: projectRoot });
    } catch (err) {
      log.error("deploy: smoke test failed", { error: err instanceof Error ? err.message : String(err) });
      process.exit(1);
    }
  } else {
    log.info("deploy: step 8/8 smoke test (skipped via --no-test)");
  }

  log.info("deploy: complete");
}

main().catch((err) => {
  log.error("deploy: unhandled error", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
