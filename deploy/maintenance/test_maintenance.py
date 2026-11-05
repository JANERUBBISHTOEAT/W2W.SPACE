#!/usr/bin/env python3
"""Real, isolated Docker smoke test; never connects to a deployment host.

Requires the reviewed proxy image, a local W2W image containing Node, Docker,
and openssl. Evidence is kept outside the checkout; all test containers/networks
and the generated TLS private key are removed on success or failure.
"""
import argparse
import contextlib
import fcntl
import hashlib
import http.client
import importlib.util
import io
import json
import os
from pathlib import Path
import secrets
import socket
import ssl
import subprocess
import sys
import time
import traceback
from unittest.mock import patch

sys.dont_write_bytecode = True

HERE = Path(__file__).resolve().parent
HOST = "maintenance.test"
COMMIT = "a" * 40
WRONG_COMMIT = "b" * 40
FIXTURE_LABEL = "space.w2w.maintenance.fixture"


def load_tool():
    spec = importlib.util.spec_from_file_location("w2w_maintenance_under_test", HERE / "maintenance.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Smoke:
    def __init__(self, evidence, app_image):
        self.module = load_tool()
        self.suffix = secrets.token_hex(6)
        self.base = evidence / ("run-" + self.suffix)
        self.base.mkdir(parents=True, mode=0o700)
        self.work = self.base / "compose"
        self.work.mkdir(mode=0o755)
        for name in ("vhost", "html", "certs", "state"):
            directory = self.work / name
            directory.mkdir(mode=0o755 if name != "state" else 0o700)
            directory.chmod(0o755 if name != "state" else 0o700)
        self.network = "w2w-maintenance-test-" + self.suffix
        self.proxy = self.network + "-proxy"
        self.app = self.network + "-app"
        self.app_image = app_image
        self.key = hashlib.sha256((str(self.work) + "\n" + HOST).encode()).hexdigest()[:16]
        self.env = dict(os.environ)
        for name in ("DOCKER_CONTEXT", "DOCKER_TLS", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"):
            self.env.pop(name, None)
        self.env["DOCKER_HOST"] = "unix:///var/run/docker.sock"
        self.env["W2W_RELEASE_STATE_DIR"] = str(self.work / "state")
        self.labels = ["--label", FIXTURE_LABEL + "=" + self.suffix,
                       "--label", self.module.LABEL + "=" + self.key]
        self.report = {"production_access": False, "fixture_network": self.network,
                       "proxy_image": self.module.IMAGE, "app_fixture_image": app_image,
                       "script_sha256": self.sha(HERE / "maintenance.py"), "checks": [],
                       "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
        self.report["source_sha256"] = {name: self.sha(HERE / name) for name in
                                        ("maintenance.py", "nginx.conf", "location-override.conf", "index.html")}
        self.network_created = False

    @staticmethod
    def sha(path):
        return hashlib.sha256(path.read_bytes()).hexdigest()

    def docker(self, *args, optional=False):
        result = subprocess.run(["docker", "--host=unix:///var/run/docker.sock", *args],
                                env=self.env, capture_output=True, text=True, timeout=60)
        if result.returncode and not optional:
            raise RuntimeError("Fixture Docker command failed: " + " ".join(args[:3]) + ": " + result.stderr[-500:])
        return result.stdout.strip() if result.returncode == 0 else None

    def inspect(self, name, expression):
        return json.loads(self.docker("inspect", "--format", expression, name))

    def record_check(self, name, **details):
        self.report["checks"].append({"name": name, "status": "passed", **details})

    def request(self, path="/", method="GET", tls=True, extra=None):
        port = self.https_port if tls else self.http_port
        raw = socket.create_connection(("127.0.0.1", port), timeout=5)
        transport = raw
        if tls:
            context = ssl.create_default_context(cafile=str(self.cert))
            transport = context.wrap_socket(raw, server_hostname=HOST)
        try:
            headers = {"Host": HOST, "Connection": "close", **(extra or {})}
            if method == "POST":
                headers["Content-Length"] = "0"
            transport.sendall((method + " " + path + " HTTP/1.1\r\n" +
                               "\r\n".join(name + ": " + value for name, value in headers.items()) +
                               "\r\n\r\n").encode())
            response = http.client.HTTPResponse(transport, method=method)
            response.begin()
            return response.status, {k.lower(): v for k, v in response.getheaders()}, response.read()
        finally:
            transport.close()

    def eventually(self, fn, seconds=15):
        deadline = time.monotonic() + seconds
        last = None
        while time.monotonic() < deadline:
            try:
                return fn()
            except Exception as error:
                last = error
                time.sleep(0.2)
        raise AssertionError("Fixture readiness timed out: " + str(last))

    def tool(self, action, commit=None, success=True):
        args = [sys.executable, str(HERE / "maintenance.py"), action,
                "--compose-dir", str(self.work), "--proxy", self.proxy, "--app", self.app,
                "--host", HOST, "--https-port", str(self.https_port),
                "--probe-address", "127.0.0.1", "--ca-file", str(self.cert)]
        if commit:
            args += ["--expected-commit", commit]
        result = subprocess.run(args, env=self.env, capture_output=True, text=True, timeout=60)
        with (self.base / "operations.log").open("a") as log:
            log.write(action + " exit=" + str(result.returncode) + "\n" + result.stdout + result.stderr + "\n")
        assert (result.returncode == 0) == success, (action, result.returncode, result.stdout, result.stderr)
        return json.loads(result.stdout) if success else result.stderr

    def make_app(self):
        source = '''import http from 'node:http';
http.createServer((req,res)=>{
  if(req.url==='/health'){
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({status:'ok',version:process.env.APP_REVISION}));
  }else {res.setHeader('Content-Type','text/plain');res.end('application-fixture');}
}).listen(3000,'0.0.0.0');'''
        self.docker("run", "-d", "--pull", "never", "--name", self.app, *self.labels,
                    "--network", self.network, "--no-healthcheck", "--expose", "3000",
                    "--env", "VIRTUAL_HOST=" + HOST, "--env", "LETSENCRYPT_HOST=" + HOST,
                    "--env", "VIRTUAL_PORT=3000", "--env", "APP_REVISION=" + COMMIT,
                    "--env", "TRUSTED_PROXY_CIDRS=" + self.proxy_ip + "/32",
                    "--entrypoint", "node", self.app_image, "--input-type=module", "-e", source)

    def normal_health(self):
        status, _, body = self.request("/health")
        assert status == 200 and json.loads(body) == {"status": "ok", "version": COMMIT}

    def maintenance_response(self, path="/", method="GET", extra=None):
        status, headers, body = self.request(path, method, extra=extra)
        assert status == 503, (path, method, status)
        for key, value in {"retry-after": "120", "cache-control": "no-store",
                           "x-content-type-options": "nosniff", "referrer-policy": "no-referrer"}.items():
            assert headers.get(key) == value, (key, headers)
        assert "max-age=31536000" in headers.get("strict-transport-security", ""), headers
        assert "script-src 'none'" in headers.get("content-security-policy", ""), headers
        assert "text/html" in headers.get("content-type", ""), headers
        if method == "HEAD":
            assert body == b""
        else:
            assert hashlib.sha256(body).hexdigest() == self.sha(HERE / "index.html")
        return headers

    def assert_anchor(self):
        tool = self.module.Maintenance(self.args)
        record = json.loads(tool.record.read_text())
        actual = self.inspect(tool.name, '{"id":{{json .Id}},"readonly":{{json .HostConfig.ReadonlyRootfs}},'
                              '"user":{{json .Config.User}},"ports":{{json .HostConfig.PortBindings}},'
                              '"mounts":{{json .Mounts}},"caps":{{json .HostConfig.CapDrop}},'
                              '"security":{{json .HostConfig.SecurityOpt}}}')
        assert actual["id"] == record["anchor_id"]
        assert actual["readonly"] and actual["user"] == "101:101"
        assert not actual["ports"] and actual["caps"] == ["ALL"]
        assert any(value.startswith("no-new-privileges") for value in actual["security"])
        assert all("docker.sock" not in mount["Destination"] and "/cert" not in mount["Destination"]
                   for mount in actual["mounts"])
        assert tool.assets.stat().st_mode & 0o777 == 0o755
        assert (tool.assets / "index.html").stat().st_mode & 0o777 == 0o644
        assert tool.state.stat().st_mode & 0o777 == 0o700
        return actual["id"]

    def setup(self):
        assert self.docker("image", "inspect", "--format", "{{.Id}}", self.module.IMAGE) == self.module.IMAGE_ID
        self.docker("image", "inspect", "--format", "{{.Id}}", self.app_image)
        self.cert = self.work / "certs" / (HOST + ".crt")
        self.private_key = self.work / "certs" / (HOST + ".key")
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-days", "1", "-nodes",
                        "-keyout", str(self.private_key), "-out", str(self.cert), "-subj", "/CN=" + HOST,
                        "-addext", "subjectAltName=DNS:" + HOST], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.private_key.chmod(0o600)
        challenge = self.work / "html" / ".well-known" / "acme-challenge"
        challenge.mkdir(parents=True, mode=0o755)
        challenge.parent.chmod(0o755)
        challenge.chmod(0o755)
        (challenge / "synthetic-token").write_text("acme-fixture")
        (challenge / "synthetic-token").chmod(0o644)
        self.docker("network", "create", "--label", FIXTURE_LABEL + "=" + self.suffix, self.network)
        self.network_created = True
        self.docker("run", "-d", "--pull", "never", "--name", self.proxy, *self.labels,
                    "--label", "com.github.nginx-proxy.nginx-proxy.nginx=true", "--network", self.network,
                    "--publish", "127.0.0.1::80", "--publish", "127.0.0.1::443",
                    "--mount", "type=bind,src=/var/run/docker.sock,dst=/tmp/docker.sock,readonly",
                    "--mount", "type=bind,src=" + str(self.work / "vhost") + ",dst=/etc/nginx/vhost.d",
                    "--mount", "type=bind,src=" + str(self.work / "html") + ",dst=/usr/share/nginx/html",
                    "--mount", "type=bind,src=" + str(self.work / "certs") + ",dst=/etc/nginx/certs,readonly",
                    "--env", "DOCKER_HOST=unix:///tmp/docker.sock", "--env", "TRUST_DOWNSTREAM_PROXY=false",
                    "--env", "DOCKER_CONTAINER_FILTERS=label=" + self.module.LABEL + "=" + self.key,
                    self.module.IMAGE)
        self.proxy_before = self.inspect(self.proxy, '{"id":{{json .Id}},"networks":{{json .NetworkSettings.Networks}}}')
        self.proxy_ip = self.proxy_before["networks"][self.network]["IPAddress"]
        self.http_port = int(self.docker("port", self.proxy, "80/tcp").rsplit(":", 1)[1])
        self.https_port = int(self.docker("port", self.proxy, "443/tcp").rsplit(":", 1)[1])
        self.args = argparse.Namespace(compose_dir=str(self.work), host=HOST, proxy=self.proxy, app=self.app,
                                       expected_commit=COMMIT, probe_address="127.0.0.1",
                                       https_port=self.https_port, ca_file=str(self.cert))
        self.certificate_before = self.sha(self.cert)
        self.sentinel_ids = {}
        for role in ("redis", "acme"):
            name = self.network + "-" + role + "-sentinel"
            self.docker("run", "-d", "--pull", "never", "--name", name, *self.labels,
                        "--network", self.network, "--entrypoint", "sh", self.module.IMAGE,
                        "-c", "sleep 600")
            self.sentinel_ids[name] = self.inspect(name, "{{json .Id}}")
        self.make_app()
        self.eventually(self.normal_health)
        self.app_before = self.inspect(self.app, "{{json .Id}}")
        self.record_check("verified TLS baseline app health", certificate_verification="CERT_REQUIRED, matching SNI/hostname")

    def lock_checks(self):
        assert self.module.NoRedirect().redirect_request(None, None, 302, "Found", {},
                                                        "https://uncontacted.invalid/") is None
        self.record_check("public verifier refuses redirects", scope="handler unit check, no external request")
        class NoDockerMaintenance:
            def __init__(inner, args):
                pass

            def preflight(inner):
                pass

            def enable(inner):
                return {"fixture": "lock-only; no Docker calls"}

        xdg = self.base / "xdg-state"
        override = self.base / "explicit-state"
        argv = ["maintenance.py", "enable", "--compose-dir", str(self.work)]
        environment = dict(os.environ)
        environment.pop("W2W_RELEASE_STATE_DIR", None)
        environment["XDG_STATE_HOME"] = str(xdg)
        with patch.dict(os.environ, environment, clear=True), patch.object(sys, "argv", argv), \
                patch.object(self.module, "Maintenance", NoDockerMaintenance), contextlib.redirect_stdout(io.StringIO()):
            self.module.main()
            assert (xdg / "w2w-releases" / ".lock").is_file()
            os.environ["W2W_RELEASE_STATE_DIR"] = str(override)
            self.module.main()
            assert (override / ".lock").is_file()
            with (override / ".lock").open("a") as held:
                fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
                try:
                    self.module.main()
                except BlockingIOError:
                    pass
                else:
                    raise AssertionError("Maintenance did not coordinate with the existing release lock")
        self.record_check("shared release lock uses explicit override, then XDG_STATE_HOME and refuses contention",
                          scope="main() with a no-Docker fixture")

    def run_checks(self):
        tool = self.module.Maintenance(self.args)
        # Existing operator files are refused, never silently overwritten.
        sentinel = b"# existing operator hook\n"
        tool.hook.write_bytes(sentinel)
        self.tool("enable", success=False)
        assert tool.hook.read_bytes() == sentinel and not tool.state.exists()
        tool.hook.unlink()
        target = self.work / "operator-hook"
        target.write_bytes(sentinel)
        tool.hook.symlink_to(target)
        self.tool("enable", success=False)
        assert tool.hook.is_symlink() and target.read_bytes() == sentinel
        tool.hook.unlink()
        self.record_check("existing hook and symlink refused unchanged")
        # nginx-proxy includes vhost.d/default only when the host snippet is absent.
        fallback = self.work / "vhost" / "default"
        unsafe = b"location = /maintenance-bypass { return 200 'bypass'; }\n"
        fallback.write_bytes(unsafe)
        self.tool("enable", success=False)
        assert fallback.read_bytes() == unsafe and not tool.state.exists()
        fallback.unlink()
        self.record_check("effective default server snippet with a custom location is refused unchanged")

        # A created container is insufficient: maintenance must verify its own
        # service independently of a healthy app keeping the same vhost alive.
        class StoppedAfterStart(self.module.Maintenance):
            def start(inner):
                anchor_id = super().start()
                self.docker("stop", inner.name)
                return anchor_id

        class RaisedAfterStart(self.module.Maintenance):
            def start(inner):
                super().start()
                raise RuntimeError("synthetic failure after anchor creation")

        for variant in (StoppedAfterStart, RaisedAfterStart):
            failing = variant(self.args)
            failing.preflight()
            try:
                failing.enable()
            except RuntimeError as error:
                expected = "not running" if variant is StoppedAfterStart else "synthetic failure after anchor creation"
                assert expected in str(error), str(error)
            else:
                raise AssertionError("Failed maintenance anchor was accepted")
            failed_record = json.loads(failing.record.read_text())
            assert failed_record["phase"] == "enable-failed-restored" and failed_record.get("anchor_id")
            assert not failing.hook.exists() and self.module.inspect(failing.name) is None
            assert self.inspect(self.app, "{{json .Id}}") == self.app_before
            self.eventually(self.normal_health)
        self.record_check("stopped startup and post-creation exception both restore app and retain exact anchor identity in failure record")

        self.tool("enable")
        assert self.inspect(self.app, "{{json .Id}}") == self.app_before
        self.record_check("normal maintenance enable preserves the running app container")
        first_anchor = self.assert_anchor()
        for path, method in [("/", "GET"), ("/deep/link?x=1", "GET"), ("/health", "GET"),
                             ("/", "HEAD"), ("/api/action", "POST")]:
            self.maintenance_response(path, method)
            self.record_check("maintenance HTTP semantics", path=path, method=method)
        self.maintenance_response(extra={"X-Forwarded-Host": "attacker.invalid", "X-Forwarded-Proto": "http"})
        self.record_check("forged forwarding remains maintenance with TLS/HSTS/CSP")
        status, _, body = self.request("/.well-known/acme-challenge/synthetic-token", tls=False)
        assert status == 200 and body == b"acme-fixture", (status, body)
        status, _, _ = self.request("/.well-known/acme-challenge/absent", tls=False)
        assert status == 404
        self.record_check("HTTP ACME challenge bypass", known=200, missing=404,
                          scope="challenge serving only; no certificate issuance or renewal")
        self.maintenance_response("/.well-known/acme-challenge/synthetic-token")
        self.record_check("HTTPS challenge URL follows maintenance catchall; HTTP-01 remains available")

        self.docker("stop", self.app)
        self.eventually(self.maintenance_response)
        self.tool("disable", COMMIT, success=False)
        self.maintenance_response()
        self.docker("rm", self.app)
        self.eventually(self.maintenance_response)
        self.tool("disable", COMMIT, success=False)
        self.maintenance_response("/health")
        self.record_check("app stopped and removed retain valid TLS/503; disable refused")
        status, _, body = self.request("/.well-known/acme-challenge/synthetic-token", tls=False)
        assert status == 200 and body == b"acme-fixture"
        self.record_check("HTTP-01 challenge remains available after application removal")

        self.make_app()
        tool.preflight()
        def ready_app():
            assert tool.app_health(COMMIT)
        self.eventually(ready_app)
        self.tool("disable", WRONG_COMMIT, success=False)
        self.maintenance_response()
        self.record_check("wrong commit refused without unmasking")

        class StopWithoutRemoval(self.module.Maintenance):
            injected = False

            def remove_anchor(inner):
                if not inner.injected:
                    inner.injected = True
                    self.docker("stop", inner.name)
                    raise RuntimeError("synthetic failure after stopping owned anchor")
                return super().remove_anchor()

        stopped_recovery = StopWithoutRemoval(self.args)
        stopped_recovery.preflight()
        try:
            stopped_recovery.disable(COMMIT)
        except RuntimeError as error:
            assert "synthetic failure after stopping owned anchor" in str(error), str(error)
        else:
            raise AssertionError("Injected incomplete anchor removal was ignored")
        assert stopped_recovery.injected and self.assert_anchor() == first_anchor
        assert self.inspect(stopped_recovery.name, "{{json .State.Running}}")
        assert json.loads(stopped_recovery.record.read_text())["phase"] == "disable-failed-maintenance-restored"
        self.maintenance_response()
        self.record_check("failed off restarts the stopped owned anchor with the same recorded ID and verified 503 service")

        # Inject one external check failure after a healthy app is unmasked.
        class FailPublicOnce(self.module.Maintenance):
            injected = False

            def request(inner, path="/health"):
                if not inner.injected and not inner.hook.exists():
                    inner.injected = True
                    return 502, {}, b"synthetic public failure"
                return super().request(path)

        saved_environment = dict(os.environ)
        try:
            os.environ.update(self.env)
            for name in ("DOCKER_CONTEXT", "DOCKER_TLS", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"):
                os.environ.pop(name, None)
            recovering = FailPublicOnce(self.args)
            recovering.preflight()
            try:
                recovering.disable(COMMIT)
            except RuntimeError as error:
                assert "Public application health/version" in str(error), str(error)
            else:
                raise AssertionError("Injected public check failure was ignored")
            assert recovering.injected
        finally:
            os.environ.clear()
            os.environ.update(saved_environment)
        recovered_anchor = self.assert_anchor()
        assert first_anchor != recovered_anchor
        assert json.loads(tool.record.read_text())["phase"] == "disable-failed-maintenance-restored"
        self.maintenance_response()
        self.record_check("public verification failure restores maintenance and exact new anchor identity")

        self.tool("disable", COMMIT)
        self.eventually(self.normal_health)
        status, _, body = self.request("/other")
        assert status == 200 and body == b"application-fixture"
        assert not tool.hook.exists() and not tool.assets.exists()
        self.record_check("healthy exact commit disable restores normal app and removes only owned page/hook")
        self.tool("enable")
        self.assert_anchor()
        self.maintenance_response()
        self.record_check("re-enable after completed disable")

        # A same-name, same-label replacement is not the recorded owned instance.
        old_anchor = self.assert_anchor()
        self.docker("rm", "-f", tool.name)
        self.docker("run", "-d", "--pull", "never", "--name", tool.name,
                    "--label", self.module.LABEL + "=" + self.key, "--network", self.network,
                    "--entrypoint", "sh", self.module.IMAGE, "-c", "sleep 600")
        replacement = self.inspect(tool.name, "{{json .Id}}")
        assert replacement != old_anchor
        self.tool("inspect", success=False)
        self.tool("disable", COMMIT, success=False)
        assert self.inspect(tool.name, "{{json .Id}}") == replacement
        self.eventually(self.maintenance_response)
        self.record_check("same-label replacement ID refused by inspect/disable and not cleaned")

        after = self.inspect(self.proxy, '{"id":{{json .Id}},"networks":{{json .NetworkSettings.Networks}}}')
        assert after == self.proxy_before
        trust = self.docker("inspect", "--format", '{{range .Config.Env}}{{if eq (index (split . "=") 0) "TRUSTED_PROXY_CIDRS"}}{{.}}{{end}}{{end}}', self.app)
        assert trust == "TRUSTED_PROXY_CIDRS=" + self.proxy_ip + "/32"
        assert self.sha(self.cert) == self.certificate_before
        for name, container_id in self.sentinel_ids.items():
            assert self.inspect(name, "{{json .Id}}") == container_id
        self.docker("exec", self.proxy, "nginx", "-t")
        self.record_check("proxy ID/IP, certificate hash, exact app trust and unrelated sentinel IDs unchanged",
                          proxy_ip=self.proxy_ip, trusted_proxy_cidr=self.proxy_ip + "/32",
                          certificate_sha256=self.certificate_before,
                          sentinel_scope="plain sleeping containers only, no Redis data or ACME process; functional renewal not tested")
        assert self.report["source_sha256"] == {name: self.sha(HERE / name) for name in self.report["source_sha256"]}, \
            "Source files changed during the test; rerun the final frozen version"

    def cleanup(self):
        self.report["cleanup"] = {}
        # This run's cryptographic path-derived ownership key scopes every item.
        names = self.docker("ps", "-a", "--filter", "label=" + self.module.LABEL + "=" + self.key,
                            "--format", "{{.Names}}", optional=True) or ""
        for name in names.splitlines():
            try:
                if name == self.proxy:
                    log = self.docker("logs", name, optional=True)
                    if log is not None:
                        (self.base / "proxy.log").write_text(log + "\n")
                    config = self.docker("exec", name, "cat", "/etc/nginx/conf.d/default.conf", optional=True)
                    if config:
                        (self.base / "generated.conf").write_text(config + "\n")
                self.docker("rm", "-f", name)
                self.report["cleanup"][name] = "removed"
            except Exception as error:
                self.report["cleanup"][name] = str(error)
        if self.network_created:
            try:
                self.docker("network", "rm", self.network)
                self.report["cleanup"][self.network] = "removed"
            except Exception as error:
                self.report["cleanup"][self.network] = str(error)
        if hasattr(self, "private_key"):
            self.private_key.unlink(missing_ok=True)
        self.report["test_private_key_removed"] = True
        if any(value != "removed" for value in self.report["cleanup"].values()):
            self.report["status"] = "failed"
            self.report["cleanup_error"] = "Some owned fixture resources could not be removed"

    def capture_failure(self):
        config = self.docker("exec", self.proxy, "cat", "/etc/nginx/conf.d/default.conf", optional=True)
        if config:
            (self.base / "generated-at-failure.conf").write_text(config + "\n")
        result = subprocess.run(["docker", "--host=unix:///var/run/docker.sock", "exec", self.proxy,
                                 "nginx", "-t"], env=self.env, capture_output=True, text=True, timeout=15)
        (self.base / "nginx-at-failure.txt").write_text(result.stdout + result.stderr)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence-dir", "--evidence", dest="evidence", type=Path,
                        default=Path("/workspace/w2w-maintenance-test"))
    parser.add_argument("--app-image", default="zheyuanwei/w2w:cfd32e77735385b8e2e7e6e13209bc60ee36e92c")
    args = parser.parse_args()
    os.umask(0o077)
    smoke = Smoke(args.evidence.resolve(), args.app_image)
    try:
        smoke.lock_checks()
        smoke.setup()
        smoke.run_checks()
        smoke.report["status"] = "passed"
    except Exception as error:
        smoke.report["status"] = "failed"
        smoke.report["error"] = str(error)
        (smoke.base / "traceback.txt").write_text(traceback.format_exc())
        try:
            smoke.capture_failure()
        except Exception:
            pass
    finally:
        smoke.cleanup()
        smoke.report["finished_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        (smoke.base / "results.json").write_text(json.dumps(smoke.report, indent=2) + "\n")
        print(json.dumps({"status": smoke.report["status"], "checks": len(smoke.report["checks"]),
                          "evidence": str(smoke.base / "results.json"), "error": smoke.report.get("error")}, indent=2))
    return 0 if smoke.report["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
