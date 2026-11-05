"""Private synthetic fixtures for test_auto_release.py; no production access."""
import argparse
import hashlib
import http.client
import importlib.util
import json
import os
import re
from pathlib import Path
import secrets
import shutil
import socket
import ssl
import subprocess
import sys
import threading
import time
import urllib.request

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.dont_write_bytecode = True
sys.path.insert(0, str(HERE))
from test_maintenance import Smoke, HOST, FIXTURE_LABEL

A = "a" * 40
B = "b" * 40
C = "c" * 40
SELECTORS = ("DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH")
DOCKER = shutil.which("docker")
if not DOCKER:
    DOCKER = "/usr/local/bin/docker"

SERVER = r'''import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
const rev=process.env.APP_REVISION;
function config(){try{return JSON.parse(fs.readFileSync('/fixture-control/control.json','utf8'));}catch{return {};}}
if(config().crash?.[rev])process.exit(17);
function ping(){return new Promise((resolve,reject)=>{let data='';const s=net.createConnection({host:'redis',port:6379});s.setTimeout(750,()=>s.destroy(new Error('fixture redis timeout')));s.once('error',reject);s.once('connect',()=>s.write('*1\r\n$4\r\nPING\r\n'));s.on('data',b=>{data+=b;if(data.includes('\r\n')){s.destroy();data==='+PONG\r\n'?resolve():reject(new Error('fixture redis response'));}});});}
const server=http.createServer(async(req,res)=>{if(config().crash?.[rev])process.exit(17);if(req.url==='/health'){try{await ping();const ok=process.env.FIXTURE_HEALTH_MODE==='ok';res.writeHead(ok?200:503,{'content-type':'application/json'});res.end(JSON.stringify({status:ok?'ok':'synthetic-failure',version:rev}));}catch{res.writeHead(503);res.end('fixture redis unavailable');}}else{res.end('application-fixture');}});
server.listen(3000,'0.0.0.0');process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
'''
DOCKERFILE = '''FROM NODE_IMAGE AS cached-node
FROM REDIS_IMAGE
COPY --from=cached-node /usr/local/bin/node /usr/local/bin/node
COPY --from=cached-node /lib/x86_64-linux-gnu/libstdc++.so.6 /lib/x86_64-linux-gnu/libstdc++.so.6
COPY --from=cached-node /lib/x86_64-linux-gnu/libgcc_s.so.1 /lib/x86_64-linux-gnu/libgcc_s.so.1
COPY --chmod=0444 server.mjs /fixture/server.mjs
RUN --network=none chmod 0755 /fixture
ARG REVISION
ARG MODE
ARG OWNER
LABEL org.opencontainers.image.revision=$REVISION space.w2w.auto-release.fixture=$OWNER
ENV APP_REVISION=$REVISION FIXTURE_HEALTH_MODE=$MODE
USER 1000:1000
WORKDIR /fixture
ENTRYPOINT ["node", "/fixture/server.mjs"]
'''


def execute(args, env=None, cwd=None, timeout=180, check=True):
    result = subprocess.run(args, env=env, cwd=cwd, capture_output=True, text=True, timeout=timeout)
    if check and result.returncode:
        raise RuntimeError("Fixture command failed (%s): %s" % (result.returncode, " ".join(args[:3])) + ": " + result.stderr[-1000:])
    return result


def docker(*args, **kwargs):
    environment = dict(kwargs.pop("env", os.environ))
    for key in SELECTORS:
        environment.pop(key, None)
    return execute([DOCKER, "--host=unix:///var/run/docker.sock"] + list(args), env=environment, **kwargs)


def private(path, value):
    path.write_text(value)
    path.chmod(0o600)


def load_auto():
    spec = importlib.util.spec_from_file_location("auto_release_under_test", HERE / "auto_release.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class Images:
    def __init__(self, evidence, node_image, redis_image):
        self.id = secrets.token_hex(6)
        self.base = evidence / ("suite-" + self.id)
        self.base.mkdir(parents=True, mode=0o700)
        self.node_image, self.redis_image = node_image, redis_image
        self.registry = "w2w-auto-registry-" + self.id
        self.registry_network = self.registry + "-network"
        self.registry_volume = self.registry + "-data"
        self.images = {}
        self.report = {"production_access": False, "images": self.images, "checks": [], "cases": []}
        self.created = []
        self.registry_image_preexisting = docker("image", "inspect", "registry:2", check=False).returncode == 0

    def save(self):
        private(self.base / "results.json", json.dumps(self.report, indent=2) + "\n")

    def setup(self):
        docker("image", "inspect", self.node_image)
        docker("image", "inspect", self.redis_image)
        if not self.registry_image_preexisting:
            result = docker("pull", "registry:2", timeout=180)
            private(self.base / "registry-pull.log", result.stdout + result.stderr)
        for kind, name in (("network", self.registry_network), ("volume", self.registry_volume)):
            docker(kind, "create", "--label", "space.w2w.auto-release.fixture=" + self.id, name)
            self.created.append((kind, name))
        docker("run", "-d", "--name", self.registry, "--pull", "never", "--network", self.registry_network,
               "--label", "space.w2w.auto-release.fixture=" + self.id, "--publish", "127.0.0.1::5000",
               "--mount", "type=volume,src=" + self.registry_volume + ",dst=/var/lib/registry", "registry:2")
        self.created.append(("container", self.registry))
        self.port = int(docker("inspect", "--format", '{{(index (index .NetworkSettings.Ports "5000/tcp") 0).HostPort}}', self.registry).stdout)
        for attempt in range(50):
            try:
                with urllib.request.urlopen("http://127.0.0.1:%s/v2/" % self.port, timeout=1) as response:
                    if response.status == 200:
                        break
            except Exception:
                time.sleep(.1)
        else:
            raise RuntimeError("Fixture registry not ready")
        build = self.base / "build"
        build.mkdir()
        private(build / "Dockerfile", DOCKERFILE.replace("NODE_IMAGE", self.node_image).replace("REDIS_IMAGE", self.redis_image))
        private(build / "server.mjs", SERVER)
        private(build / ".dockerignore", "*\n!Dockerfile\n!server.mjs\n")
        self.build = build
        self.build_one("a", A, "ok")
        self.save()

    def build_one(self, name, revision, mode):
        tag = "w2w-auto-" + self.id + ":" + name
        remote = "127.0.0.1:%s/w2w-auto/%s:%s" % (self.port, self.id, name)
        env = dict(os.environ)
        env["BUILDX_CONFIG"] = str(self.base / "buildx")
        result = docker("build", "--pull=false", "--build-arg", "REVISION=" + revision,
                        "--build-arg", "MODE=" + mode, "--build-arg", "OWNER=" + self.id,
                        "-t", tag, str(self.build), env=env, timeout=180)
        private(self.base / ("build-" + name + ".log"), result.stdout + result.stderr)
        iid = docker("image", "inspect", "--format", "{{.Id}}", tag).stdout.strip()
        self.images[name] = {"tag": tag, "remote_tag": remote, "id": iid, "revision": revision}
        docker("run", "--rm", "--pull", "never", "--network", "none", "--tmpfs", "/data",
               "--entrypoint", "node", tag, "--check", "/fixture/server.mjs")
        docker("tag", tag, remote)
        result = docker("push", remote, timeout=180)
        private(self.base / ("loopback-upload-" + name + ".log"), result.stdout + result.stderr)
        refs = json.loads(docker("image", "inspect", "--format", "{{json .RepoDigests}}", remote).stdout)
        self.images[name]["digest"] = next(value for value in refs if value.startswith("127.0.0.1:%s/" % self.port))
        self.save()

    def cleanup(self):
        issues = []
        for case in self.report["cases"]:
            state = Path(case["evidence"]) / "compose" / "state"
            for record in state.glob("release-*"):
                if not record.is_dir():continue
                tag = "w2w-rollback:" + record.name
                if docker("image", "inspect", tag, check=False).returncode == 0:
                    actual = docker("image", "inspect", "--format", "{{.Id}}", tag).stdout.strip()
                    if actual not in {item["id"] for item in self.images.values()}:
                        issues.append("unrecognized rollback tag not removed")
                    elif docker("image", "rm", tag, check=False).returncode:
                        issues.append("rollback tag removal failed")
        for kind, name in reversed(self.created):
            result = docker("rm", "-f", name, check=False) if kind == "container" else docker(kind, "rm", name, check=False)
            if result.returncode:
                issues.append(kind + " cleanup failed")
        for image in self.images.values():
            for ref in (image["remote_tag"], image["tag"]):
                if docker("image", "inspect", ref, check=False).returncode == 0:
                    if docker("image", "rm", ref, check=False).returncode:
                        issues.append("image tag cleanup failed")
            if docker("image", "inspect", image["id"], check=False).returncode == 0:
                if docker("image", "rm", image["id"], check=False).returncode:
                    issues.append("synthetic image cleanup failed")
        if not self.registry_image_preexisting:
            if docker("image", "rm", "registry:2", check=False).returncode:
                issues.append("pulled registry dependency cleanup failed")
        self.report["cleanup"] = {"status": "passed" if not issues else "failed", "issues": issues}
        self.save()


class Case(Smoke):
    def __init__(self, suite, name):
        super().__init__(suite.base / name, suite.node_image)
        self.suite, self.name = suite, name
        for key in SELECTORS:
            self.env.pop(key, None)
        for key in ("COMPOSE_FILE", "COMPOSE_ENV_FILES", "COMPOSE_PROJECT_NAME", "COMPOSE_DISABLE_ENV_FILE", "W2W_IMAGE", "W2W_RELEASE_LOCK_FD", "W2W_RELEASE_TOKEN", "W2W_RELEASE_OPERATION_TOKEN", "W2W_RELEASE_RESULT_FILE"):
            self.env.pop(key, None)
        self.env["W2W_RELEASE_APPROVED"] = "1"
        self.env["PYTHONDONTWRITEBYTECODE"] = "1"
        binary = self.base / "bin"
        binary.mkdir(mode=0o700)
        shim = "#!/usr/bin/env python3\nimport os,sys\na=sys.argv[1:]\nif a and a[0].startswith('--host='):\n assert a[0]=='--host=unix:///var/run/docker.sock';a=a[1:]\ne=dict(os.environ)\nfor k in %r:e.pop(k,None)\nos.execvpe(%r,[%r,'--host=unix:///var/run/docker.sock']+a,e)\n" % (SELECTORS, DOCKER, DOCKER)
        private(binary / "docker", shim)
        (binary / "docker").chmod(0o700)
        self.env["PATH"] = str(binary) + os.pathsep + self.env["PATH"]

        self.redis = self.network + "-redis"
        self.acme = self.network + "-acme-sentinel"
        self.volume = self.network + "-data"
        self.control = self.work / "control"
        self.control.mkdir(mode=0o755)
        self.control.chmod(0o755)
        self.control_file = self.control / "control.json"
        self.set_control({})
        self.report["case"] = name
        self.report["python"] = sys.version
        self.report["faults"] = []
        self.report["observations"] = []
        self.report["operations"] = []
        self.running_processes = []
        self.report["source_sha256"].update({name: self.sha(ROOT / name) for name in ("remix/update.sh", "deploy/maintenance/auto_release.py") if (ROOT / name).is_file()})

    def docker(self, *args, optional=False):
        result = docker(*args, env=self.env, check=not optional)
        return result.stdout.strip() if result.returncode == 0 else None

    def set_control(self, value):
        self.control_file.write_text(json.dumps(value))
        self.control_file.chmod(0o644)

    def compose(self, *args, image=None, check=True):
        env = dict(self.env)
        env.pop("W2W_IMAGE", None)
        if image is not None:
            env["W2W_IMAGE"] = image
        return execute([DOCKER, "--host=unix:///var/run/docker.sock", "compose"] + list(args), env=env, cwd=self.work, check=check)

    def make_app(self):
        # Called by inherited setup only after pinned proxy IP has been discovered.
        env = "# Synthetic only; no production credentials.\nW2W_IMAGE=" + self.suite.images["a"]["digest"] + "\nKEEP_SENTINEL='unchanged synthetic value'\n"
        private(self.work / ".env", env)
        compose = '''name: PROJECT
services:
  remix:
    image: ${W2W_IMAGE}
    pull_policy: never
    container_name: APP
    environment:
      VIRTUAL_HOST: maintenance.test
      LETSENCRYPT_HOST: maintenance.test
      VIRTUAL_PORT: '3000'
      HTTPS_METHOD: redirect
      TRUSTED_PROXY_CIDRS: TRUST
      KEEP_SENTINEL: ${KEEP_SENTINEL}
    labels:
      space.w2w.maintenance: KEY
      space.w2w.maintenance.fixture: SUFFIX
    volumes: ['CONTROL:/fixture-control:ro']
    tmpfs: ['/data']
    networks: [fixture]
  redis:
    image: REDIS_IMAGE
    pull_policy: never
    container_name: REDIS
    command: ['redis-server', '--appendonly', 'yes', '--save', '']
    labels:
      space.w2w.maintenance: KEY
      space.w2w.maintenance.fixture: SUFFIX
    volumes: ['data:/data']
    networks: [fixture]
volumes:
  data:
    name: VOLUME
    labels:
      space.w2w.maintenance.fixture: SUFFIX
networks:
  fixture:
    external: true
    name: NETWORK
'''
        replacements = {"PROJECT": "w2w-auto-" + self.suffix, "APP": self.app, "TRUST": self.proxy_ip + "/32", "KEY": self.key, "SUFFIX": self.suffix, "CONTROL": str(self.control), "REDIS_IMAGE": self.suite.redis_image, "REDIS": self.redis, "VOLUME": self.volume, "NETWORK": self.network}
        for key, value in replacements.items():
            compose = re.sub(r"(?<![A-Za-z0-9_])" + re.escape(key) + r"(?![A-Za-z0-9_])", lambda match: value, compose)
        private(self.work / "compose.yml", compose)
        result = self.compose("up", "-d", "--pull", "never", "--no-build")
        private(self.base / "compose-start.log", result.stdout + result.stderr)

    def normal_health(self, revision=A):
        status, _, body = self.request("/health")
        assert status == 200 and json.loads(body) == {"status": "ok", "version": revision}, (status, body)

    def setup(self):
        # Reuse reviewed TLS/proxy setup, replacing its placeholder Redis with real Redis.
        original = self.module.COMMIT if hasattr(self.module, "COMMIT") else None
        super().setup()
        # The inherited setup uses a sleeping Redis sentinel; keep its scope explicit.
        self.sleep_redis = self.network + "-redis-sentinel"
        checked = self.module.Maintenance(self.args)
        checked.preflight()
        assert self.module.inspect(self.app)["env"]["TRUSTED_PROXY_CIDRS"] == self.proxy_ip + "/32"
        self.record_check("real maintenance preflight and exact immediate-proxy trust hard gate")
        self.redis_id = self.inspect(self.redis, "{{json .Id}}")
        self.redis_volume = self.volume
        self.baseline_proxy = self.inspect(self.proxy, '{"id":{{json .Id}},"networks":{{json .NetworkSettings.Networks}}}')
        self.acme_id = self.inspect(self.acme, "{{json .Id}}")
        self.default_before = (self.work / ".env").read_bytes()
        self.redis_command("SET", "fixture:string", "before-auto")
        self.redis_command("HSET", "fixture:hash", "owner", "synthetic-owner")
        self.redis_command("SADD", "fixture:set", "alpha", "beta")
        self.redis_command("SET", "fixture:token:999", "synthetic-file")
        assert self.data() == {"string": "before-auto", "hash": "synthetic-owner", "set": ["alpha", "beta"], "token": "synthetic-file", "new": ""}
        assert {key:self.redis_command("TYPE", key) for key in ("fixture:string", "fixture:hash", "fixture:set", "fixture:token:999")} == {"fixture:string":"string","fixture:hash":"hash","fixture:set":"set","fixture:token:999":"string"}
        self.expected_data = self.data()

    def redis_command(self, *args):
        return self.docker("exec", self.redis, "redis-cli", "-e", "--raw", *args)

    def data(self):
        return {"string": self.redis_command("GET", "fixture:string"), "hash": self.redis_command("HGET", "fixture:hash", "owner"), "set": sorted(self.redis_command("SMEMBERS", "fixture:set").splitlines()), "token": self.redis_command("GET", "fixture:token:999"), "new": self.redis_command("GET", "fixture:new")}

    def observe(self):
        before = self.module.inspect(self.app)
        try:
            status, headers, body = self.request("/health")
            item = {"time": time.monotonic(), "status": status, "body_sha256": hashlib.sha256(body).hexdigest()}
            if status == 200:
                item["version"] = json.loads(body).get("version")
            elif status == 503:
                item["maintenance_document_matches"] = hashlib.sha256(body).hexdigest() == self.sha(HERE / "index.html")
                item["retry_after"] = headers.get("retry-after")
                if item["maintenance_document_matches"] and not (self.base / "maintenance-window.html").exists():
                    (self.base / "maintenance-window.html").write_bytes(body)
                    (self.base / "maintenance-window.html").chmod(0o644)
        except Exception as error:
            item = {"time": time.monotonic(), "error": type(error).__name__}
        app = self.module.inspect(self.app)
        item["app_stable_during_request"] = (before is None and app is None) or bool(before and app and before["id"] == app["id"])
        item["app_id"] = app.get("id") if app else None
        item["app_image"] = app.get("image_id") if app else None
        states = list((self.work / "state").glob("auto-release-*/state.json"))
        if states:
            try:item["controller_phase"] = json.loads(max(states, key=lambda path: path.stat().st_mtime_ns).read_text()).get("phase")
            except (OSError, ValueError):pass
        self.report["observations"].append(item)
        return item

    def auto_args(self, image="b"):
        item = self.suite.images[image]
        return {"compose_dir": str(self.work), "host": HOST, "image": item["digest"], "revision": item["revision"], "package_root": str(ROOT), "proxy": self.proxy, "app": self.app, "ca_file": str(self.cert), "probe_address": "127.0.0.1", "https_port": self.https_port, "child_timeout": 180}

    def auto_command(self, request, fault=None):
        if fault:
            path = self.base / ("fault-request-" + str(len(self.report["operations"])) + ".json")
            private(path, json.dumps({"arguments": request, "fault": fault, "control": str(self.control_file), "fault_log": str(self.base / "fault-events.jsonl")}))
            return [sys.executable, str(HERE / "test_auto_release.py"), "--fault-worker", str(path)]
        args = [sys.executable, str(HERE / "auto_release.py")]
        for key, value in request.items():
            args += ["--" + key.replace("_", "-"), str(value)]
        return args

    def start_auto(self, image="b", fault=None, changes=None):
        request = self.auto_args(image)
        request.update(changes or {})
        index = len(self.report["operations"])
        stdout = (self.base / ("auto-%s.stdout" % index)).open("w")
        stderr = (self.base / ("auto-%s.stderr" % index)).open("w")
        process = subprocess.Popen(self.auto_command(request, fault), env=self.env, stdout=stdout, stderr=stderr, start_new_session=True)
        self.running_processes.append(process)
        self.report["operations"].append({"index": index, "request": request, "fault": fault, "process_id": process.pid})
        return process, stdout, stderr, index

    def finish_auto(self, running, timeout=240):
        process, stdout, stderr, index = running
        try:
            deadline = time.monotonic() + timeout
            while process.poll() is None and time.monotonic() < deadline:
                self.observe()
                time.sleep(.25)
            if process.poll() is None:
                raise RuntimeError("Auto-release fixture timeout")
        finally:
            stdout.close(); stderr.close()
        output = (self.base / ("auto-%s.stdout" % index)).read_text()
        result = json.loads(output)
        self.report["operations"][index].update({"returncode": process.returncode, "result": result})
        assert result.get("schema") == "w2w-auto-release-v1"
        assert result["exit_code"] == process.returncode
        assert result["compose_directory"] == str(self.work) and result["host"] == HOST
        if result.get("transaction_directory"):
            transaction = Path(result["transaction_directory"])
            assert transaction.parent == self.work / "state" and not transaction.is_symlink()
            assert (transaction / "operation-token").read_text().strip() == result["operation_token"]
        return result

    def auto(self, image="b", fault=None, changes=None):
        return self.finish_auto(self.start_auto(image, fault, changes))

    def assert_invariants(self):
        assert self.inspect(self.proxy, '{"id":{{json .Id}},"networks":{{json .NetworkSettings.Networks}}}') == self.baseline_proxy
        assert self.inspect(self.redis, "{{json .Id}}") == self.redis_id
        assert self.inspect(self.acme, "{{json .Id}}") == self.acme_id
        assert self.sha(self.cert) == self.certificate_before
        assert self.data() == self.expected_data
        current_env = (self.work / ".env").read_bytes()
        filtered = lambda contents: b"".join(line for line in contents.splitlines(keepends=True) if not line.startswith(b"W2W_IMAGE="))
        assert filtered(current_env) == filtered(self.default_before)
        assert (self.work / ".env").stat().st_mode & 0o777 == 0o600
        actual = self.docker("inspect", "--format", '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}', self.redis)
        assert actual == self.volume
        app = self.module.inspect(self.app)
        if app:
            assert app["env"].get("TRUSTED_PROXY_CIDRS") == self.proxy_ip + "/32"
        self.record_check("proxy/Redis/ACME IDs, proxy IP, certificate, trust and all synthetic data preserved", acme_scope="unrelated sleeping sentinel; no certificate issuance/renewal")

    def verify_backup(self, result):
        record_path = result.get("release_record")
        assert record_path, "A real update must return its owned release record"
        record = Path(record_path)
        rdb = record / "redis.rdb"
        assert rdb.is_file(), "A real update must retain its verified RDB"
        assert self.sha(rdb) == (record / "redis.rdb.sha256").read_text().split()[0]
        assert rdb.stat().st_mode & 0o777 == 0o600
        name = self.network + "-restore"
        script = 'redis-check-rdb /data/dump.rdb >/dev/null; exec redis-server --dir /data --dbfilename dump.rdb --appendonly no --save "" --port 0 --unixsocket /tmp/restore.sock'
        self.docker("run", "-d", "--name", name, *self.labels, "--pull", "never", "--network", "none", "--tmpfs", "/data", "--mount", "type=bind,src=" + str(rdb) + ",dst=/data/dump.rdb,readonly", "--entrypoint", "sh", self.suite.redis_image, "-ec", script)
        try:
            def ready():
                assert self.docker("exec", name, "redis-cli", "-s", "/tmp/restore.sock", "ping", optional=True) == "PONG"
            self.eventually(ready)
            def read(*args):
                return self.docker("exec", name, "redis-cli", "-s", "/tmp/restore.sock", "--raw", *args)
            assert read("GET", "fixture:string") == "before-auto"
            assert read("HGET", "fixture:hash", "owner") == "synthetic-owner"
            assert sorted(read("SMEMBERS", "fixture:set").splitlines()) == ["alpha", "beta"]
            assert read("GET", "fixture:token:999") == "synthetic-file"
            assert read("GET", "fixture:new") == self.expected_data["new"]
            assert {key:read("TYPE", key) for key in ("fixture:string", "fixture:hash", "fixture:set", "fixture:token:999")} == {"fixture:string":"string","fixture:hash":"hash","fixture:set":"set","fixture:token:999":"string"}
            assert self.inspect(name, "{{json .HostConfig.NetworkMode}}") == "none"
            mounts = self.inspect(name, "{{json .Mounts}}")
            assert any(m["Type"] == "bind" and m["Destination"] == "/data/dump.rdb" and not m["RW"] for m in mounts)
            self.record_check("independent RDB restore content/checksum/0600 with network none and read-only backup", record=str(record))
        finally:
            self.docker("rm", "-f", name, optional=True)

    def close_case(self, error=None):
        for process in self.running_processes:
            if process.poll() is None:
                process.terminate()
                try:process.wait(timeout=30)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, 9);process.wait(timeout=10)
                    self.report["forced_timeout_cleanup"] = True
        if error:
            self.report.update(status="failed", error=str(error))
        else:
            self.report["status"] = "passed"
        try:
            self.assert_invariants()
        except Exception as invariant_error:
            self.report.update(status="failed", invariant_error=str(invariant_error))
        try:
            down = self.compose("down", "--volumes", "--remove-orphans", check=False)
            self.report["compose_down_exit_code"] = down.returncode
            if down.returncode:self.report["status"] = "failed"
        except Exception as cleanup_error:
            self.report.update(status="failed", compose_cleanup_error=str(cleanup_error))
        super().cleanup()
        if self.docker("volume", "inspect", self.volume, optional=True) is not None:
            owner = self.docker("volume", "inspect", "--format", '{{index .Labels "space.w2w.maintenance.fixture"}}', self.volume)
            assert owner == self.suffix
            self.docker("volume", "rm", self.volume)
        residual = {"containers": self.docker("ps", "-aq", "--filter", "label=" + self.module.LABEL + "=" + self.key), "networks": self.docker("network", "ls", "-q", "--filter", "label=" + FIXTURE_LABEL + "=" + self.suffix), "volumes": self.docker("volume", "ls", "-q", "--filter", "label=" + FIXTURE_LABEL + "=" + self.suffix)}
        self.report["resource_residuals"] = residual
        if any(residual.values()):self.report["status"] = "failed"
        for token in (self.work / "state").glob("**/operation-token"):
            token.unlink()
        self.report["operation_tokens_removed"] = True
        self.report["finished_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        private(self.base / "results.json", json.dumps(self.report, indent=2) + "\n")
        self.suite.report["cases"].append({"name": self.name, "status": self.report["status"], "evidence": str(self.base), "checks": len(self.report["checks"]), "error": self.report.get("error") or self.report.get("invariant_error")})
        self.suite.save()
