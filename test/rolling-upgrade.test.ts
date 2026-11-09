// The order of a rolling restart in scripts/upgrade.sh. Docker is replaced here by a small stand-in that records what it was told, so this checks the script's logic, not Docker.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);

/** `new_health` is what each new container reports. Containers are numbered, and a scale up adds the next. */
function standIn(newHealth: string) {
  const folder = mkdtempSync(join(tmpdir(), "rolling-"));
  writeFileSync(join(folder, "containers"), "old1\nold2\n");
  writeFileSync(join(folder, "log"), "");
  writeFileSync(join(folder, "docker"), `#!/usr/bin/env bash
state="${folder}"
echo "$*" >> "$state/log"
case "$1" in
  compose)
    shift
    case "$1" in
      ps) cat "$state/containers" ;;
      up) echo "new$(wc -l < "$state/log" | tr -d ' ')" >> "$state/containers" ;;
    esac ;;
  inspect) case "$4" in old*) echo healthy ;; *) echo "${newHealth}" ;; esac ;;
  stop) ;;
  logs) echo "the container's last words" ;;
  rm) sed -i.bak "/^\${@: -1}$/d" "$state/containers" ;;
esac
`);
  writeFileSync(join(folder, "curl"), "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(join(folder, "docker"), 0o755);
  chmodSync(join(folder, "curl"), 0o755);
  return folder;
}

const upgrade = (folder: string, extra: Record<string, string> = {}) => run("bash", ["scripts/upgrade.sh"], {
  env: {
    ...process.env, PATH: `${folder}:${process.env.PATH}`, DATABASE_ADMIN_URL: "", BACKUP_PASSPHRASE: "a-test-only-passphrase", BACKUP_DIR: folder,
    PG_DUMP_COMMAND: "echo a-dump", PG_RESTORE_COMMAND: "cat > /dev/null; true", MIGRATE_COMMAND: `echo migrated >> ${folder}/log`,
    ROLLING_SERVICES: "web", READY_URL: "http://127.0.0.1:1/ready", READY_ATTEMPTS: "1", HEALTH_TIMEOUT: "4", ...extra,
  },
});
const log = (folder: string) => readFileSync(join(folder, "log"), "utf8").trim().split("\n");
const containers = (folder: string) => readFileSync(join(folder, "containers"), "utf8").trim().split("\n");
const position = (lines: string[], text: string) => lines.findIndex((line) => line.includes(text));

test("each old container stops only after a new one is healthy, and migrations come first", async () => {
  const folder = standIn("healthy");
  await upgrade(folder);
  const lines = log(folder);
  assert.ok(position(lines, "migrated") < position(lines, "compose up"));
  assert.ok(position(lines, "--scale web=3") < position(lines, "inspect"));
  assert.ok(position(lines, "inspect") < position(lines, "stop --time 80 old1"));
  assert.ok(position(lines, "rm old1") < position(lines, "stop --time 80 old2"));
  assert.ok(lines.filter((line) => line.startsWith("inspect")).length >= 2, "each replacement is checked");
  assert.ok(lines.every((line) => !line.startsWith("compose up") || line.includes("--no-deps")), "nothing runs migrate again");
  assert.deepEqual(containers(folder).filter((name) => name.startsWith("old")), []);
  assert.equal(containers(folder).length, 2, "the count ends where it began");
});

test("a new container that fails its check is removed, and the old ones keep serving", async () => {
  const folder = standIn("unhealthy");
  const failed = await upgrade(folder).then(() => undefined, (error) => error as { stderr: string; code: number });
  assert.ok(failed, "the upgrade must stop");
  assert.match(failed.stderr, /rolling restart step failed/);
  assert.match(failed.stderr, /still serving on the old version/);
  const lines = log(folder);
  assert.ok(lines.every((line) => !line.startsWith("stop")), "no old container is stopped");
  assert.ok(lines.some((line) => line.startsWith("rm --force new")));
  assert.deepEqual(containers(folder), ["old1", "old2"]);
});

test("a container that never reports healthy runs out of time the same way", async () => {
  const folder = standIn("starting");
  await assert.rejects(upgrade(folder, { HEALTH_TIMEOUT: "2" }));
  assert.deepEqual(containers(folder), ["old1", "old2"]);
});

test("a failed migration stops before any container changes", async () => {
  const folder = standIn("healthy");
  await assert.rejects(upgrade(folder, { MIGRATE_COMMAND: "false" }));
  assert.ok(log(folder).every((line) => !line.startsWith("compose")));
});
