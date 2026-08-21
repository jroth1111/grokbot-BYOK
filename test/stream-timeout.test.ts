/**
 * Tests for the stream idle-timeout guard.
 *
 * Uses real timers with small delays to exercise the actual setTimeout logic.
 */
import { describe, it, expect } from "vitest";
import { createStreamTimeout } from "../src/providers/stream-timeout.js";

/** Promise that resolves after `ms` milliseconds. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("createStreamTimeout", () => {
  it("fires onTimeout after timeoutMs once armed", () =>
    new Promise<void>((resolve) => {
      let fired = false;
      const guard = createStreamTimeout(20, () => {
        fired = true;
        resolve();
      });
      // Arm the guard (the guard does not auto-arm; reset() starts the timer).
      guard.reset();
      // Safety net: fail the test if it never fires.
      setTimeout(() => {
        if (!fired) {
          expect.unreachable("onTimeout did not fire");
          resolve();
        }
      }, 500);
    }));

  it("does NOT fire if reset() is called before timeout", async () => {
    let fired = false;
    const guard = createStreamTimeout(20, () => {
      fired = true;
    });
    // Reset repeatedly within the timeout window so it never fires.
    guard.reset();
    await delay(10);
    guard.reset();
    await delay(10);
    guard.reset();
    await delay(10);
    guard.clear();
    // Wait well past the original timeout to be sure nothing fires.
    await delay(60);
    expect(fired).toBe(false);
  });

  it("fires after timeout if reset() is called once then no more resets", () =>
    new Promise<void>((resolve) => {
      let fired = false;
      const guard = createStreamTimeout(50, () => {
        fired = true;
        resolve();
      });
      // Reset once, then stop — should still fire after the new timeout.
      guard.reset();
      setTimeout(() => {
        if (!fired) {
          expect.unreachable("onTimeout did not fire after reset");
          resolve();
        }
      }, 500);
    }));

  it("does NOT fire after clear() is called", async () => {
    let fired = false;
    const guard = createStreamTimeout(20, () => {
      fired = true;
    });
    guard.clear();
    await delay(60);
    expect(fired).toBe(false);
  });

  it("multiple reset() calls keep the stream alive indefinitely", async () => {
    let fired = false;
    const guard = createStreamTimeout(100, () => {
      fired = true;
    });
    // Reset several times, each well within the timeout window (3x margin).
    for (let i = 0; i < 6; i++) {
      guard.reset();
      await delay(30);
    }
    guard.clear();
    await delay(150);
    expect(fired).toBe(false);
  });

  it("clear() prevents a pending timeout from firing", async () => {
    let fired = false;
    const guard = createStreamTimeout(100, () => {
      fired = true;
    });
    guard.reset();
    // Clear before the timeout elapses (3x margin so a slow event loop
    // cannot let the timer fire before clear() runs).
    await delay(30);
    guard.clear();
    await delay(150);
    expect(fired).toBe(false);
  });

  it("reset() after clear() is a no-op (doesn't re-arm)", async () => {
    let fired = false;
    const guard = createStreamTimeout(20, () => {
      fired = true;
    });
    guard.clear();
    // Resetting after clear should not re-arm the timer.
    guard.reset();
    await delay(60);
    expect(fired).toBe(false);
  });

  it("handles timeoutMs of 0 (fires immediately or very quickly once armed)", () =>
    new Promise<void>((resolve) => {
      let fired = false;
      const guard = createStreamTimeout(0, () => {
        fired = true;
        resolve();
      });
      // Arm with timeoutMs=0 so it fires on the next tick.
      guard.reset();
      setTimeout(() => {
        if (!fired) {
          expect.unreachable("onTimeout did not fire for timeoutMs=0");
          resolve();
        }
      }, 200);
    }));
});
