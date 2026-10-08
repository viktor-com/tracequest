/** Import first in tests that load server-http or server-state (avoids ENOSPC from fs.watch). */
process.env.TRACEQUEST_SKIP_LR_WATCH = "1";