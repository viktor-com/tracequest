/**
 * /run watch page browser coverage: real tracequest serve + headless
 * Chromium + a PRIVATE tmux server + stub `claude` agents. Scenario bodies
 * live in test/helpers/run-watch-scenarios.js (shared with the fact-anchored
 * tests in test/browser/launch-page.test.js). Runs only under
 * `npm run test:browser` (TRACEQUEST_SKIP_PLAYWRIGHT=1 keeps it out of
 * npm test).
 */
import "../helpers/skip-lr-watch-env.js";
import { describe, test, afterEach, after } from "node:test";
import { SKIP_NO_PLAYWRIGHT } from "../helpers/playwright-gate.js";
import { SKIP_NO_TMUX } from "../helpers/tmux-gate.js";
import { createRunWatchHarness } from "../helpers/run-watch-scenarios.js";

/** Playwright AND tmux must both be present. */
const SKIP_NO_BOTH = SKIP_NO_PLAYWRIGHT.skip ? SKIP_NO_PLAYWRIGHT : SKIP_NO_TMUX;

const harness = createRunWatchHarness({
  socket: `tq-test-runwatch-${process.pid}`,
  session: `tq-runwatch-${process.pid}`,
});

afterEach(() => harness.afterEachCleanup());
after(() => harness.teardown());

describe("run watch page in a served browser", () => {
  test("viewport content changes between polls while the agent writes", SKIP_NO_BOTH, async () => {
    await harness.scenarioLiveTick();
  });

  test("a finished run reaches the exited state with polling stopped", SKIP_NO_BOTH, async () => {
    await harness.scenarioExited();
  });

  test("kill from the watch page ends the run and shows the gone state", SKIP_NO_BOTH, async () => {
    await harness.scenarioKill();
  });

  test("composer send paths reach the run: typed Enter, round send button, keys popover", SKIP_NO_BOTH, async () => {
    await harness.scenarioInput();
  });

  test("composer Stop control interrupts the run to the exited state", SKIP_NO_BOTH, async () => {
    await harness.scenarioStop();
  });

  test("chat transcript renders appended session events live without a reload", SKIP_NO_BOTH, async () => {
    await harness.scenarioChatLive();
  });

  test("chat transcript shows the pending state while no session is linked", SKIP_NO_BOTH, async () => {
    await harness.scenarioChatPending();
  });

  test("in-composer state feedback: live activity line, send-morphs-to-stop, held follow-up queue with cancel/edit/send-now and in-order auto-delivery", SKIP_NO_BOTH, async () => {
    await harness.scenarioComposerFeedback();
  });
});
