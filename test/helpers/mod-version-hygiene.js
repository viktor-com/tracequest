import { beforeEach, afterEach } from "node:test";
import { clearRouteCache } from "../../src/routes/route-cache.js";
import { _acquireModVersionTestIsolation } from "../../src/server/server-live-reload.js";
import { resetHotModulesCacheForTests } from "../../src/server/server-state.js";

/**
 * Serializes modVersion bumps and restores baseline + hotModules/route caches after each test.
 * Call once per file that uses bumpModVersion (parallel-safe with the global isolation chain).
 */
export function installModVersionTestHygiene() {
  /** @type {{ release(): void } | undefined} */
  let isolate;

  beforeEach(async () => {
    isolate = await _acquireModVersionTestIsolation();
  });

  afterEach(() => {
    resetHotModulesCacheForTests();
    clearRouteCache();
    isolate?.release();
    isolate = undefined;
  });
}