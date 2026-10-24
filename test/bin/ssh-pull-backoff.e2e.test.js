/**
 * `import ssh` backs off a failing host (fact hubbo). Real bin/tracequest.js
 * runs; `ssh` on PATH is a stand-in that times out while a flag file exists
 * and otherwise accepts the connection, so a host can go down and come back.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkTmp } from "../helpers/fixtures.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIN = join(ROOT, "bin/tracequest.js");
const MIN = 60 * 1000;

const home = mkTmp("tq-pull-backoff-");
const bin = join(home, "bin");
const hostsDir = join(home, "hosts");
const statePath = join(hostsDir, ".pull-state.json");
const downFlag = join(home, "gpu-down");
const sshLog = join(home, "ssh.log");
after(() => rmSync(home, { recursive: true, force: true }));

mkdirSync(bin, { recursive: true });
mkdirSync(join(home, ".tracequest"), { recursive: true });
writeFileSync(join(home, ".tracequest", "import-hosts"), "gpu\n");
writeFileSync(join(bin, "ssh"), `#!/bin/sh
case " $* " in
  *" -fN "*)
    echo connect >> "${sshLog}"
    if [ -e "${downFlag}" ]; then echo "ssh: connect to host gpu port 22: Connection timed out" >&2; exit 255; fi
    exit 0 ;;
  *" -O "*) exit 0 ;;
esac
echo "No such file or directory" >&2
exit 1
`);
writeFileSync(join(bin, "rsync"), "#!/bin/sh\nexit 0\n");
chmodSync(join(bin, "ssh"), 0o755);
chmodSync(join(bin, "rsync"), 0o755);

function importSsh(...hosts) {
  const res = spawnSync(process.execPath, [BIN, "import", "ssh", ...hosts], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      PATH: `${bin}:${process.env.PATH}`,
      TRACEQUEST_HOSTS_DIR: hostsDir,
      TRACEQUEST_SSH_RSYNC: join(bin, "rsync"),
      TRACEQUEST_IMPORT_SSH_FIXTURE: "",
      TRACEQUEST_SKIP_LR_WATCH: "1",
    },
  });
  return { ...res, out: `${res.stdout}${res.stderr}` };
}
const connects = () => (existsSync(sshLog) ? readFileSync(sshLog, "utf8").split("\n").filter(Boolean).length : 0);
const record = () => JSON.parse(readFileSync(statePath, "utf8")).hosts.gpu;
/** Pretend the last attempt happened `ms` ago, keeping the failure count. */
function lastAttemptAgo(ms, consecutiveFailures = record().consecutiveFailures) {
  const doc = JSON.parse(readFileSync(statePath, "utf8"));
  doc.hosts.gpu = { ...doc.hosts.gpu, consecutiveFailures, lastAttemptAt: new Date(Date.now() - ms).toISOString() };
  writeFileSync(statePath, JSON.stringify(doc));
}

test("a failing host is retried on a doubling, capped delay and picked up again once it is back", () => {
  writeFileSync(downFlag, "");

  let run = importSsh();
  assert.equal(connects(), 1);
  assert.equal(record().consecutiveFailures, 1);
  const firstAttempt = record().lastAttemptAt;

  run = importSsh();
  assert.equal(connects(), 1, "second run right after a failure must not connect");
  assert.match(run.out, /skip gpu \(backing off after 1 failed pulls in a row, next try after /);
  assert.equal(record().lastAttemptAt, firstAttempt, "a skipped host keeps its pull record");
  assert.equal(record().consecutiveFailures, 1);

  run = importSsh("gpu");
  assert.equal(connects(), 2, "a host named on the command line is always attempted");
  assert.equal(record().consecutiveFailures, 2);

  lastAttemptAgo(29 * MIN);
  importSsh();
  assert.equal(connects(), 2, "two failures wait 30 minutes");
  lastAttemptAgo(31 * MIN);
  importSsh();
  assert.equal(connects(), 3);
  assert.equal(record().consecutiveFailures, 3);

  lastAttemptAgo(59 * MIN);
  importSsh();
  assert.equal(connects(), 3, "three failures wait an hour");

  lastAttemptAgo(119 * MIN, 868);
  importSsh();
  assert.equal(connects(), 3, "the wait is capped at two hours");
  lastAttemptAgo(121 * MIN, 868);
  importSsh();
  assert.equal(connects(), 4, "the capped wait still lets the host be tried");
  assert.equal(record().consecutiveFailures, 869);

  rmSync(downFlag);
  importSsh();
  assert.equal(connects(), 4, "a host that came back waits out its delay");
  lastAttemptAgo(121 * MIN);
  run = importSsh();
  assert.equal(connects(), 5);
  assert.equal(run.status, 0, run.out);
  assert.equal(record().ok, true);
  assert.equal(record().consecutiveFailures, 0);
  assert.ok(record().lastSuccessAt);

  importSsh();
  assert.equal(connects(), 6, "after a good pull the next run attempts the host again");
});
