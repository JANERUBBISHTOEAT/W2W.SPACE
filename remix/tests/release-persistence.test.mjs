import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";

const execute = promisify(execFile);
const updateScript = fileURLToPath(new URL("../update.sh", import.meta.url));
const previousID = `sha256:${"1".repeat(64)}`;
const targetID = `sha256:${"2".repeat(64)}`;
const redisID = `sha256:${"3".repeat(64)}`;
const staleRef = `example/w2w@sha256:${"4".repeat(64)}`;
const previousRef = `example/w2w@sha256:${"5".repeat(64)}`;
const targetRef = `example/w2w@sha256:${"6".repeat(64)}`;
const previousRevision = "a".repeat(40);
const revision = "b".repeat(40);
const originalEnv = `# retain comments and CRLF\r\nSESSION_SECRET='synthetic-private-value'\r\nW2W_IMAGE=${staleRef} # original default is stale\r\nTRUSTED_PROXY_CIDRS=172.18.0.2/32\r\nREDIS_HOST=redis\r\n`;

// Exercise the real Bash/Python/file transaction without a Docker daemon or
// production credentials. The separate Docker smoke test verifies Compose itself.
const dockerFixture = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const statePath = process.env.W2W_FIXTURE_STATE;
const state = JSON.parse(fs.readFileSync(statePath));
const args = process.argv.slice(2);
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
const output = value => process.stdout.write(String(value) + '\\n');
const imageID = ref => ref === state.targetRef ? state.targetID : ref === state.redisID ? state.redisID : state.previousID;
const selected = () => process.env.W2W_IMAGE || ((fs.readFileSync('.env', 'utf8').match(/^W2W_IMAGE=([^\\s#]+)/m) || [])[1]) || state.staleRef;
state.commands.push(args);
save();
if (args[0] === 'compose') {
  if (args[1] === 'version') output('Docker Compose fixture');
  else if (args[1] === 'config') {
    const image = selected();
    state.selections.push({ image, override: process.env.W2W_IMAGE !== undefined });
    save();
    output(JSON.stringify({ services: {
      remix: { image, environment: { TRUSTED_PROXY_CIDRS: (state.changeModel || (state.changeDefaultModel && !process.env.W2W_IMAGE)) && image === state.targetRef ? '0.0.0.0/0' : '172.18.0.2/32' } },
      redis: { image: state.redisID, volumes: ['retained-data:/data'] },
      proxy: { image: 'retained-proxy', environment: { HTTPS_METHOD: 'noredirect' } }
    }}));
  } else if (args[1] === 'ps') output(args.at(-1) === 'redis' ? 'fixture-redis' : 'fixture-app');
  else if (args[1] === 'up') {
    const image = selected();
    state.selections.push({ image, override: process.env.W2W_IMAGE !== undefined, up: true });
    save();
    if (state.failUp && imageID(image) === state.targetID) process.exit(1);
    if (state.failRollbackUp && imageID(image) === state.previousID && state.activeImage === state.targetID) process.exit(1);
    state.activeImage = imageID(image);
    state.activeRef = image;
    save();
  } else process.exit(2);
} else if (args[0] === 'inspect') {
  if (args[2] === '{{.Config.Image}}') output(state.activeRef);
  else output(args.at(-1) === 'fixture-redis' ? state.redisID : state.activeImage);
} else if (args[0] === 'image' && args[1] === 'inspect') {
  const ref = args.at(-1);
  const format = args[3] || '';
  if (args[2] !== '--format') output('{}');
  else if (format.includes('RepoDigests')) output(JSON.stringify([state.previousRef]));
  else if (format.includes('revision')) output(imageID(ref) === state.targetID ? state.revision : state.previousRevision);
  else output(imageID(ref));
} else if (args[0] === 'exec') {
  if (args[2] === 'node' && state.failHealth && state.activeImage === state.targetID) process.exit(1);
} else if (args[0] === 'cp') fs.writeFileSync(args[2], 'synthetic-rdb');
else if (!['pull', 'run', 'image'].includes(args[0])) process.exit(2);
`;

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "w2w-release-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const binaryDirectory = join(directory, "bin");
  const composeDirectory = join(directory, "compose");
  const stateDirectory = join(directory, "records");
  await Promise.all([binaryDirectory, composeDirectory, stateDirectory].map((path) => mkdir(path)));
  const statePath = join(directory, "docker-state.json");
  await writeFile(statePath, JSON.stringify({
    previousID, targetID, redisID, staleRef, previousRef, targetRef, previousRevision, revision,
    activeImage: previousID, activeRef: previousRef, commands: [], selections: [], ...options,
  }));
  await writeFile(join(binaryDirectory, "docker"), dockerFixture, { mode: 0o700 });
  await writeFile(join(composeDirectory, ".env"), originalEnv, { mode: 0o600 });
  const environment = { ...process.env, PATH: `${binaryDirectory}${delimiter}${process.env.PATH}`, W2W_FIXTURE_STATE: statePath, W2W_RELEASE_APPROVED: "1", W2W_RELEASE_STATE_DIR: stateDirectory };
  for (const key of ["W2W_IMAGE", "COMPOSE_ENV_FILES", "COMPOSE_DISABLE_ENV_FILE", "COMPOSE_FILE"]) delete environment[key];
  const run = async (action, ...args) => {
    try {
      return { ...(await execute("bash", [updateScript, action, composeDirectory, ...args], { env: environment, timeout: 15000 })), code: 0 };
    } catch (error) {
      return { stdout: error.stdout || "", stderr: error.stderr || "", code: error.code };
    }
  };
  return {
    binaryDirectory, composeDirectory, stateDirectory, environment,
    run,
    release: () => run("release", targetRef, revision),
    state: async () => JSON.parse(await readFile(statePath, "utf8")),
    env: () => readFile(join(composeDirectory, ".env"), "utf8"),
    record: async () => join(stateDirectory, (await readdir(stateDirectory)).find((name) => name.startsWith("release-"))),
  };
}

const platform = { skip: process.platform === "win32" ? "The server release script requires Linux Bash/flock/Python" : false };

test("release persists its verified image, and rollback persists the actual prior runtime despite a stale default", platform, async (t) => {
  const app = await fixture(t);
  const metadata = await stat(join(app.composeDirectory, ".env"));
  const released = await app.release();
  assert.equal(released.code, 0, released.stderr);
  assert.equal(await app.env(), originalEnv.replace(staleRef, targetRef));
  assert.equal((await app.state()).activeImage, targetID);
  const releasedMetadata = await stat(join(app.composeDirectory, ".env"));
  assert.equal(releasedMetadata.mode, metadata.mode);
  assert.equal(releasedMetadata.uid, metadata.uid);
  assert.equal(releasedMetadata.gid, metadata.gid);
  const rolledBack = await app.run("rollback", await app.record());
  assert.equal(rolledBack.code, 0, rolledBack.stderr);
  assert.equal(await app.env(), originalEnv.replace(staleRef, previousRef));
  assert.equal((await app.state()).activeImage, previousID);
  assert.equal(await readFile(join(app.stateDirectory, "current-image"), "utf8"), `${previousRef}\n`);
  assert(![released, rolledBack].some((result) => `${result.stdout}${result.stderr}`.includes("synthetic-private-value")));
  for (const name of await readdir(await app.record())) {
    assert(!(await readFile(join(await app.record(), name), "utf8")).includes("synthetic-private-value"), `Release record must not contain environment secrets: ${name}`);
  }
  assert((await app.state()).selections.filter((selection) => selection.up).every((selection) => !selection.override));
});

test("a missing image assignment is appended, and an inherited shell override cannot mask the persisted default", platform, async (t) => {
  const app = await fixture(t);
  const withoutImage = originalEnv.replace(/^W2W_IMAGE=[^\n]*\n/m, "");
  await writeFile(join(app.composeDirectory, ".env"), withoutImage);
  app.environment.W2W_IMAGE = "example/unrelated:override";
  const result = await app.release();
  assert.equal(result.code, 0, result.stderr);
  assert.equal(await app.env(), `${withoutImage}W2W_IMAGE=${targetRef}\r\n`);
  const state = await app.state();
  assert.equal(state.activeImage, targetID);
  assert(state.selections.some((selection) => selection.image === targetRef && !selection.override));
});

test("older release records without a registry reference persist the verified previous image ID", platform, async (t) => {
  const app = await fixture(t);
  assert.equal((await app.release()).code, 0);
  await rm(join(await app.record(), "previous-reference"));
  const result = await app.run("rollback", await app.record());
  assert.equal(result.code, 0, result.stderr);
  assert.equal(await app.env(), originalEnv.replace(staleRef, previousID));
  assert.equal((await app.state()).activeImage, previousID);
});

test("failed explicit rollback restores its actual pre-rollback runtime and durable default", platform, async (t) => {
  const app = await fixture(t, { failRollbackUp: true });
  assert.equal((await app.release()).code, 0);
  const result = await app.run("rollback", await app.record());
  assert.notEqual(result.code, 0);
  assert.equal(await app.env(), originalEnv.replace(staleRef, targetRef));
  assert.equal((await app.state()).activeImage, targetID);
  assert.equal(await readFile(join(await app.record(), "status"), "utf8"), "rollback-failed-restored\n");
});

test("an invalid rollback record fails without replacing the app or its default", platform, async (t) => {
  const app = await fixture(t);
  const result = await app.run("rollback", join(app.stateDirectory, "missing-record"));
  assert.notEqual(result.code, 0);
  assert.equal(await app.env(), originalEnv);
  assert(!(await app.state()).commands.some((args) => args[0] === "compose" && args[1] === "up"));
});

test("a directory at a state-file destination cannot silently absorb an atomic state update", platform, async (t) => {
  const app = await fixture(t);
  const invalidStatePath = join(app.stateDirectory, "current-image");
  await mkdir(invalidStatePath);
  const result = await app.release();
  assert.notEqual(result.code, 0);
  assert.deepEqual(await readdir(invalidStatePath), []);
  assert.equal((await app.state()).activeImage, previousID);
  assert.equal(await app.env(), originalEnv.replace(staleRef, previousRef));
});

for (const failure of ["failUp", "failHealth"]) {
  test(`${failure} restores the actual previous runtime and durable reference instead of its stale default`, platform, async (t) => {
    const app = await fixture(t, { [failure]: true });
    const result = await app.release();
    assert.notEqual(result.code, 0);
    assert.equal((await app.state()).activeImage, previousID);
    assert.equal(await app.env(), originalEnv.replace(staleRef, previousRef));
    assert(!result.stdout.includes("Application image and health version verified:"));
  });
}

test("unsupported environment sources and ambiguous dotenv forms stop before app replacement", platform, async (t) => {
  for (const kind of ["symlink", "hardlink", "duplicate", "multiline", "control-file", "control-process"]) {
    await t.test(kind, async (subtest) => {
      const app = await fixture(subtest);
      const envPath = join(app.composeDirectory, ".env");
      if (kind === "symlink") {
        const privatePath = join(app.composeDirectory, "private.env");
        await writeFile(privatePath, originalEnv, { mode: 0o600 });
        await rm(envPath);
        await symlink(privatePath, envPath);
      } else if (kind === "hardlink") {
        await link(envPath, join(app.composeDirectory, "private.env"));
      } else if (kind === "duplicate") await writeFile(envPath, `${originalEnv}W2W_IMAGE=${targetRef}\n`);
      else if (kind === "multiline") await writeFile(envPath, `SECRET='first line\nW2W_IMAGE=${targetRef}\nlast line'\n${originalEnv}`);
      else if (kind === "control-file") await writeFile(envPath, `${originalEnv}COMPOSE_ENV_FILES=private.env\n`);
      else app.environment.COMPOSE_DISABLE_ENV_FILE = "1";
      const before = await app.env();
      const result = await app.release();
      assert.notEqual(result.code, 0);
      assert.equal(await app.env(), before);
      assert(!(await app.state()).commands.some((args) => args[0] === "compose" && args[1] === "up"));
    });
  }
});

test("an image override that changes another Compose setting is rejected without app replacement", platform, async (t) => {
  const app = await fixture(t, { changeModel: true });
  const result = await app.release();
  assert.notEqual(result.code, 0);
  assert.equal(await app.env(), originalEnv);
  assert(!(await app.state()).commands.some((args) => args[0] === "compose" && args[1] === "up"));
});

test("a default Compose mismatch after persistence restores the actual previous image before any target replacement", platform, async (t) => {
  const app = await fixture(t, { changeDefaultModel: true });
  const result = await app.release();
  assert.notEqual(result.code, 0);
  assert.equal(await app.env(), originalEnv.replace(staleRef, previousRef));
  const state = await app.state();
  assert.equal(state.activeImage, previousID);
  assert(state.selections.filter((selection) => selection.up).every((selection) => selection.image === previousRef));
});

test("atomic replacement failure reports failure without changing the app, environment, or leaving secret copies", platform, async (t) => {
  const app = await fixture(t);
  const { stdout } = await execute("bash", ["-c", "command -v python3"]);
  const realPython = stdout.trim();
  const injection = "import os\ndef denied(*args,**kwargs): raise OSError('synthetic replace failure')\nos.replace=denied\n";
  const wrapper = `#!${process.execPath}
const fs = require('node:fs');
const cp = require('node:child_process');
const source = fs.readFileSync(0, 'utf8');
const args = process.argv.slice(2);
const inject = args.includes('set') ? ${JSON.stringify(injection)} : '';
const result = cp.spawnSync(${JSON.stringify(realPython)}, args, { input: inject + source, stdio: ['pipe', 'inherit', 'inherit'] });
process.exit(result.status ?? 1);
`;
  await writeFile(join(app.binaryDirectory, "python3"), wrapper, { mode: 0o700 });
  const result = await app.release();
  assert.notEqual(result.code, 0);
  assert.equal(await app.env(), originalEnv);
  assert.equal((await app.state()).activeImage, previousID);
  assert(!(await app.state()).commands.some((args) => args[0] === "compose" && args[1] === "up"));
  assert.deepEqual(await readdir(app.composeDirectory), [".env"]);
  assert(!`${result.stdout}${result.stderr}`.includes("synthetic-private-value"));
});
