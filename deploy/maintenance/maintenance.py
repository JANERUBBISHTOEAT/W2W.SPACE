#!/usr/bin/env python3
"""Explicit, host-local maintenance controls. No application release is performed."""
import argparse
import fcntl
import hashlib
import http.client
import ipaddress
import json
import os
from pathlib import Path
import re
import socket
import ssl
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

IMAGE = "jwilder/nginx-proxy@sha256:dd563441c6037b0faaede052359731eef319d2eb465d11e089dc4a4c4d499c04"
IMAGE_ID = "sha256:cafe7db32b26c5bb88be0650c6df94b4d4a0f2d5a6dd3e1b22f213382372cbd2"
TEMPLATE_HASH = "938356f4633a02759f1e48b4c9784761726c21f599ffa609c7d3c72b55da0df2"
LABEL = "space.w2w.maintenance"
HERE = Path(__file__).resolve().parent
ENV_KEYS = {"VIRTUAL_HOST", "VIRTUAL_PATH", "VIRTUAL_HOST_MULTIPORTS", "VIRTUAL_PORT", "LETSENCRYPT_HOST", "HTTPS_METHOD", "CERT_NAME", "TRUST_DOWNSTREAM_PROXY", "TRUSTED_PROXY_CIDRS", "APP_REVISION"}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, file_pointer, code, message, headers, new_url):
        return None


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def docker(*args, timeout=30, optional=False):
    environment = dict(os.environ)
    for name in ("DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"):
        environment.pop(name, None)
    result = subprocess.run(["docker", "--host=unix:///var/run/docker.sock", *args], env=environment, capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        if optional:
            return None
        # Docker errors can contain unrelated container configuration. Do not dump it.
        raise RuntimeError("Docker command failed: " + " ".join(args[:2]))
    return result.stdout.strip()


def inspect(name):
    # Query only routing metadata. Never request Config.Env or a complete inspect.
    choices = " ".join('(eq (index (split . "=") 0) "' + key + '")' for key in sorted(ENV_KEYS))
    template = ('{"id":{{json .Id}},"image_id":{{json .Image}},"image":{{json .Config.Image}},'
                '"running":{{json .State.Running}},"owner":{{if .Config.Labels}}{{json (index .Config.Labels "' + LABEL + '")}}{{else}}null{{end}},'
                '"networks":{{json .NetworkSettings.Networks}},"mounts":{{json .Mounts}},'
                '"ports":{{json .HostConfig.PortBindings}},"env":[{{range .Config.Env}}{{if or ' + choices + '}}{{json .}},{{end}}{{end}}null]}')
    result = docker("inspect", "--format", template, name, optional=True)
    if result is None:
        return None
    item = json.loads(result)
    item["env"] = dict(value.split("=", 1) for value in item["env"] if value is not None)
    return item


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def release_state_directory():
    state_home = Path(os.environ.get("XDG_STATE_HOME") or str(Path.home() / ".local/state"))
    result = Path(os.environ.get("W2W_RELEASE_STATE_DIR") or str(state_home / "w2w-releases"))
    require(result.is_absolute(), "Expected an absolute release state directory")
    return result


def atomic(path, contents, mode=0o600, exclusive=False):
    require(not path.is_symlink(), "Refusing a symbolic link: " + path.name)
    descriptor, temporary = tempfile.mkstemp(prefix=".w2w-maintenance-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(contents)
            stream.flush()
            os.fchmod(stream.fileno(), mode)
            os.fsync(stream.fileno())
        if exclusive:
            os.link(temporary, path, follow_symlinks=False)
            os.unlink(temporary)
        else:
            os.replace(temporary, path)
        descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


class Maintenance:
    def __init__(self, args):
        self.args = args
        self.work = Path(args.compose_dir)
        require(self.work.is_absolute() and self.work.is_dir() and not self.work.is_symlink(), "Use the confirmed absolute Compose directory")
        require(re.fullmatch(r"[a-z0-9]+(?:[.-][a-z0-9]+)*", args.host), "Expected a literal DNS hostname")
        if args.probe_address:
            require(ipaddress.ip_address(args.probe_address).is_loopback, "A probe address is only supported for isolated loopback tests")
        key = hashlib.sha256((str(self.work) + "\n" + args.host).encode()).hexdigest()[:16]
        self.key = key
        self.created_anchor_id = None
        self.operation_token = getattr(args, "operation_token", None)
        self.name = "w2w-maintenance-" + key
        self.state = self.work / (".w2w-maintenance-" + key)
        require(not self.state.is_symlink() and (not self.state.exists() or self.state.is_dir()), "Unexpected maintenance state directory type")
        self.record = self.state / "state.json"
        self.hook = self.work / "vhost" / (args.host + "_location_override")
        self.assets = self.work / "html" / (".w2w-maintenance-" + key)
        self.document = "__w2w_maintenance_" + key + ".html"

    def save(self, record, phase):
        if self.operation_token:
            require(record.get("operation_token") == self.operation_token, "Refusing to change another maintenance operation")
        if self.created_anchor_id:
            record["anchor_id"] = self.created_anchor_id
        record["phase"] = phase
        atomic(self.record, (json.dumps(record, indent=2) + "\n").encode())

    def owned(self, record, check_operation=True):
        require(record.get("host") == self.args.host and record.get("key") == self.key, "Maintenance record belongs to another installation")
        require(record.get("proxy_id") == self.proxy["id"], "The proxy container changed; review its identity before recovery")
        if check_operation and self.operation_token:
            require(record.get("operation_token") == self.operation_token, "Maintenance belongs to another operation")

    def preflight(self):
        self.proxy = inspect(self.args.proxy)
        require(self.proxy and self.proxy["running"] and self.proxy["image_id"] == IMAGE_ID, "Expected the reviewed running nginx-proxy image")
        require(self.proxy["env"].get("TRUST_DOWNSTREAM_PROXY") == "false", "Reviewed proxy header policy is required")
        require(len(self.proxy["networks"]) == 1, "Review a proxy attached to multiple networks separately")
        self.network, network = next(iter(self.proxy["networks"].items()))
        self.proxy_ip = network["IPAddress"]
        require(docker("image", "inspect", "--format", "{{.Id}}", IMAGE) == IMAGE_ID, "The pinned local image is unavailable; this tool never pulls images")
        require(docker("exec", self.args.proxy, "sha256sum", "/app/nginx.tmpl").split()[0] == TEMPLATE_HASH, "The proxy template differs from the tested hook implementation")
        mounts = {mount["Destination"]: mount for mount in self.proxy["mounts"]}
        for destination, source in [("/etc/nginx/vhost.d", self.work / "vhost"), ("/usr/share/nginx/html", self.work / "html")]:
            require(destination in mounts and mounts[destination]["Type"] == "bind" and Path(mounts[destination]["Source"]) == source, "Proxy mount paths differ from the reviewed installation")
            require(source.is_dir() and not source.is_symlink(), "Expected an existing regular proxy bind directory")
        certificate = self.work / "certs" / (self.args.host + ".crt")
        require(certificate.is_file(), "An existing domain TLS certificate is required")
        self.certificate_hash = digest(certificate)
        root_hash = hashlib.sha1(b"/").hexdigest()
        require(not (self.hook.parent / (self.args.host + "_" + root_hash + "_location_override")).exists(), "A more specific root hook already exists")
        for name in filter(None, docker("ps", "-q").splitlines()):
            item = inspect(name)
            hostnames = item["env"].get("VIRTUAL_HOST", "").split(",")
            if self.args.host not in hostnames:
                continue
            require(not item["env"].get("VIRTUAL_HOST_MULTIPORTS") and item["env"].get("VIRTUAL_PATH", "/") == "/", "Custom virtual paths need a separately reviewed maintenance plan")
            require(item["env"].get("HTTPS_METHOD", "redirect") == "redirect" and not item["env"].get("CERT_NAME"), "Custom HTTPS/certificate policy needs separate review")
            require(item["id"] in {(inspect(self.args.app) or {}).get("id"), (self.anchor() or {}).get("id")}, "Another container owns this virtual host")
        self.app = inspect(self.args.app)
        if self.app and self.app["running"]:
            require(self.app["env"].get("TRUSTED_PROXY_CIDRS") == self.proxy_ip + "/32", "The immediate proxy trust is not the reviewed exact /32")
        # Existing server snippets remain untouched. Refuse custom routes that can
        # outrank the root hook; ACME is the supported exception.
        snippet = self.hook.parent / self.args.host
        if not snippet.exists() and not snippet.is_symlink():
            snippet = self.hook.parent / "default"
        if snippet.exists() or snippet.is_symlink():
            require(not snippet.is_symlink() and snippet.is_file(), "Unexpected per-host snippet type")
            contents = snippet.read_text()
            locations = re.findall(r"\blocation\s+([^\{]+)\{", contents)
            require(all("/.well-known/acme-challenge/" in value for value in locations), "Existing custom locations need separate maintenance review")
            require(not re.search(r"(?m)^\s*(?:include|if|return|rewrite|error_page|proxy_pass|fastcgi_pass|uwsgi_pass)\b", contents), "Custom snippet routing needs separate maintenance review")

    def request(self, path="/health"):
        context = ssl.create_default_context(cafile=self.args.ca_file)
        if self.args.probe_address:
            transport = context.wrap_socket(socket.create_connection((self.args.probe_address, self.args.https_port), timeout=10), server_hostname=self.args.host)
            try:
                transport.sendall(("GET " + path + " HTTP/1.1\r\nHost: " + self.args.host + "\r\nConnection: close\r\n\r\n").encode())
                response = http.client.HTTPResponse(transport)
                response.begin()
                return response.status, dict(response.getheaders()), response.read()
            finally:
                transport.close()
        url = "https://" + self.args.host + (":" + str(self.args.https_port) if self.args.https_port != 443 else "") + path
        try:
            opener = urllib.request.build_opener(urllib.request.HTTPSHandler(context=context), NoRedirect())
            with opener.open(url, timeout=10) as response:
                return response.status, dict(response.headers), response.read()
        except urllib.error.HTTPError as response:
            return response.code, dict(response.headers), response.read()

    def app_health(self, expected):
        app = inspect(self.args.app)
        if not app or not app["running"] or app["env"].get("TRUSTED_PROXY_CIDRS") != self.proxy_ip + "/32":
            return False
        script = 'const r=await fetch("http://127.0.0.1:3000/health",{signal:AbortSignal.timeout(3000)});const j=await r.json();if(!r.ok||j.status!=="ok"||j.version!==process.argv[1])process.exit(1)'
        return docker("exec", self.args.app, "node", "--input-type=module", "-e", script, expected, optional=True) is not None

    def anchor(self):
        present = inspect(self.name)
        if present:
            require(present["owner"] == self.key and present["image_id"] == IMAGE_ID, "Refusing an unowned maintenance container")
            if self.record.is_file() and not self.record.is_symlink():
                saved = json.loads(self.record.read_text())
                require(not saved.get("anchor_id") or saved["anchor_id"] == present["id"], "The maintenance anchor was replaced; inspect before cleanup")
            return present
        return None

    def start(self):
        require(self.anchor() is None, "Maintenance anchor already exists")
        anchor_id = docker("run", "-d", "--pull", "never", "--name", self.name, "--label", LABEL + "=" + self.key,
               "--network", self.network, "--read-only", "--user", "101:101", "--cap-drop", "ALL",
               "--security-opt", "no-new-privileges", "--tmpfs", "/tmp:rw,noexec,nosuid,size=8m",
               "--restart", "unless-stopped", "--env", "VIRTUAL_HOST=" + self.args.host,
               "--env", "LETSENCRYPT_HOST=" + self.args.host, "--env", "VIRTUAL_PORT=8080",
               "--env", "HTTPS_METHOD=redirect", "--expose", "8080",
               "--mount", "type=bind,src=" + str(self.state / "nginx.conf") + ",dst=/etc/nginx/nginx.conf,readonly",
               "--mount", "type=bind,src=" + str(self.assets) + ",dst=/usr/share/nginx/html,readonly",
               "--entrypoint", "nginx", IMAGE, "-g", "daemon off;")
        self.created_anchor_id = anchor_id
        record = json.loads(self.record.read_text())
        record["anchor_id"] = anchor_id
        self.save(record, record["phase"])
        return anchor_id

    def remove_anchor(self):
        anchor = self.anchor()
        if anchor:
            docker("rm", "-f", anchor["id"])

    def require_anchor(self):
        anchor = self.anchor()
        require(anchor and anchor["running"], "The recorded maintenance anchor is not running")
        # Check its own fallback HTTP service, independently of an app that might
        # still keep the proxy vhost alive. This contacts container loopback only.
        response = docker("exec", self.name, "curl", "--silent", "--show-error", "--max-time", "3",
                          "--noproxy", "127.0.0.1", "--output", "/dev/null", "--write-out", "%{http_code}",
                          "http://127.0.0.1:8080/health")
        require(response == "503", "The maintenance anchor HTTP service is not ready")

    def regenerate(self, enabled):
        # Removing an already stopped anchor produces no watched connect/
        # disconnect event. Render once explicitly rather than leaving a stale
        # include pointing at a removed hook. Preserve the entrypoint's only
        # derived template variable, RESOLVERS; other environment/filter settings
        # are inherited unchanged from this same proxy container.
        resolvers = []
        for line in docker("exec", self.args.proxy, "cat", "/etc/resolv.conf").splitlines():
            parts = line.split()
            if len(parts) >= 2 and parts[0] == "nameserver":
                address = parts[1]
                if "%" in address:
                    continue
                parsed = ipaddress.ip_address(address)
                resolvers.append("[" + address + "]" if parsed.version == 6 else address)
        docker("exec", "--env", "RESOLVERS=" + " ".join(resolvers), self.args.proxy,
               "docker-gen", "/app/nginx.tmpl", "/etc/nginx/conf.d/default.conf")
        marker = "include /etc/nginx/vhost.d/" + self.hook.name + ";"
        for _ in range(40):
            config = docker("exec", self.args.proxy, "cat", "/etc/nginx/conf.d/default.conf")
            if (marker in config) == enabled and ("server_name " + self.args.host + ";") in config:
                if docker("exec", self.args.proxy, "nginx", "-t", optional=True) is None:
                    time.sleep(0.25)
                    continue
                docker("exec", self.args.proxy, "nginx", "-s", "reload")
                # Reload is asynchronous; only local container readiness is polled.
                time.sleep(0.2)
                require(inspect(self.args.proxy)["id"] == self.proxy["id"], "Proxy identity changed")
                require(digest(self.work / "certs" / (self.args.host + ".crt")) == self.certificate_hash, "TLS certificate changed")
                return
            time.sleep(0.25)
        raise RuntimeError("docker-gen did not regenerate the expected virtual-host hook")

    def check_maintenance(self):
        for path in ("/", "/health", "/token/synthetic-maintenance-check"):
            status, headers, body = self.request(path)
            headers = {name.lower(): value for name, value in headers.items()}
            require(status == 503 and headers.get("retry-after") == "120" and headers.get("cache-control") == "no-store", "Public maintenance status/headers did not verify")
            require(hashlib.sha256(body).hexdigest() == digest(self.assets / "index.html"), "Public maintenance document differs from the selected page")

    def verify_public(self, expected):
        status, _, body = self.request()
        require(status == 200 and json.loads(body) == {"status": "ok", "version": expected}, "Public application health/version did not verify after restore")

    def restore_maintenance(self, record, hook=None):
        """Restore only this operation's intact files, never a foreign window."""
        self.owned(record)
        require(self.assets.is_dir() and not self.assets.is_symlink() and
                not (self.assets / "index.html").is_symlink() and
                digest(self.assets / "index.html") == record["page_sha256"], "Maintenance assets cannot be restored safely")
        if hook is None:
            hook = (HERE / "location-override.conf").read_text().replace("__W2W_MAINTENANCE_DOCUMENT__", self.document).replace("__W2W_MAINTENANCE_DIRECTORY__", self.assets.name).encode()
        require(hashlib.sha256(hook).hexdigest() == record["hook_sha256"], "Maintenance hook cannot be restored safely")
        if self.hook.exists() or self.hook.is_symlink():
            require(self.hook.is_file() and not self.hook.is_symlink() and digest(self.hook) == record["hook_sha256"], "Refusing to overwrite a changed hook while recovering maintenance")
        else:
            atomic(self.hook, hook, 0o644, exclusive=True)
        anchor = self.anchor()
        if not anchor:
            self.created_anchor_id = None
            record.pop("anchor_id", None)
            self.save(record, "restoring-maintenance")
            record["anchor_id"] = self.start()
        elif not anchor["running"]:
            docker("start", anchor["id"])
        self.regenerate(True)
        self.require_anchor()
        self.check_maintenance()
        self.require_anchor()
        self.save(record, "disable-failed-maintenance-restored")

    def remove_hook(self, record):
        require(self.hook.is_file() and not self.hook.is_symlink() and digest(self.hook) == record["hook_sha256"], "Refusing to remove an altered or unowned maintenance hook")
        self.hook.unlink()

    def enable(self):
        if self.state.exists() and not self.state.is_symlink() and self.record.is_file() and not self.record.is_symlink():
            previous = json.loads(self.record.read_text())
            self.owned(previous, check_operation=False)
            require(previous.get("phase") in ("disabled", "enable-failed-restored") and not self.hook.exists() and self.anchor() is None, "Existing maintenance state requires inspection")
            if self.assets.exists():
                require(not self.assets.is_symlink() and set(path.name for path in self.assets.iterdir()) == {"index.html"} and not (self.assets / "index.html").is_symlink() and digest(self.assets / "index.html") == previous["page_sha256"], "Refusing altered maintenance assets")
                (self.assets / "index.html").unlink()
                self.assets.rmdir()
            self.state.rename(self.state.with_name(self.state.name + ".completed-" + str(time.time_ns())))
        require(not self.state.exists() and not self.assets.exists() and not self.hook.exists() and not self.hook.is_symlink(), "Maintenance state, assets or root hook already exist; inspect before changing them")
        require(self.anchor() is None, "A maintenance anchor already exists")
        page = HERE / "index.html"
        require(page.is_file() and not page.is_symlink() and page.stat().st_size <= 512000, "Expected the reviewed self-contained index.html")
        self.state.mkdir(mode=0o700)
        self.assets.mkdir(mode=0o755)
        self.assets.chmod(0o755)
        hook = (HERE / "location-override.conf").read_text().replace("__W2W_MAINTENANCE_DOCUMENT__", self.document).replace("__W2W_MAINTENANCE_DIRECTORY__", self.assets.name).encode()
        record = {"host": self.args.host, "key": self.key, "proxy_id": self.proxy["id"], "proxy_image": IMAGE,
                  "proxy_ip": self.proxy_ip, "hook_sha256": hashlib.sha256(hook).hexdigest(),
                  "page_sha256": digest(page), "original_commit": (self.app or {}).get("env", {}).get("APP_REVISION"), "anchor": self.name}
        if self.operation_token:
            record["operation_token"] = self.operation_token
        self.save(record, "preparing")
        hook_installed = False
        try:
            atomic(self.assets / "index.html", page.read_bytes(), 0o644)
            atomic(self.state / "nginx.conf", (HERE / "nginx.conf").read_bytes(), 0o644)
            atomic(self.hook, hook, 0o644, exclusive=True)
            hook_installed = True
            self.save(record, "enabling")
            record["anchor_id"] = self.start()
            self.regenerate(True)
            self.require_anchor()
            self.check_maintenance()
            self.require_anchor()
            self.save(record, "enabled")
            return {"mode": "maintenance", "http_status": 503, "anchor": self.name, "record": str(self.record)}
        except Exception:
            if not hook_installed:
                self.save(record, "enable-failed-before-hook")
                raise
            if record["original_commit"] and self.app_health(record["original_commit"]):
                if self.hook.exists():
                    self.remove_hook(record)
                self.remove_anchor()
                self.regenerate(False)
                self.save(record, "enable-failed-restored")
            else:
                self.save(record, "enable-failed-retained")
            raise

    def disable(self, expected):
        require(self.record.is_file() and not self.record.is_symlink(), "No regular maintenance record exists")
        record = json.loads(self.record.read_text())
        self.owned(record)
        require(self.app_health(expected), "Refusing to unmask an unhealthy app or a different commit")
        require(self.assets.is_dir() and not self.assets.is_symlink() and set(path.name for path in self.assets.iterdir()) == {"index.html"} and not (self.assets / "index.html").is_symlink() and digest(self.assets / "index.html") == record["page_sha256"], "Maintenance assets were changed; review before restoring")
        require(self.hook.is_file() and not self.hook.is_symlink() and digest(self.hook) == record["hook_sha256"], "Maintenance hook was changed; review before restoring")
        self.anchor()
        hook = self.hook.read_bytes()
        self.save(record, "disabling")
        try:
            self.remove_hook(record)
            self.remove_anchor()
            self.regenerate(False)
            self.verify_public(expected)
            # This durable commit is part of the protected unmask operation.
            # A failure must restore 503, rather than escape after exposing app.
            self.save(record, "disabled")
        except Exception:
            self.restore_maintenance(record, hook)
            raise
        # Keep the tiny non-secret recovery record/config. Remove only the owned
        # public page after normal application health is verified.
        result = {"mode": "application", "version": expected, "record": str(self.record)}
        try:
            (self.assets / "index.html").unlink()
            self.assets.rmdir()
        except OSError:
            # Public health and durable commit already succeeded. Cleanup must
            # never turn that success into a second application mutation.
            result["cleanup_warning"] = "Verified application restored; owned maintenance assets need later cleanup"
        return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["inspect", "enable", "disable"])
    parser.add_argument("--compose-dir", required=True)
    parser.add_argument("--host", default="w2w.space")
    parser.add_argument("--proxy", default="nginx-proxy")
    parser.add_argument("--app", default="remix")
    parser.add_argument("--expected-commit")
    parser.add_argument("--ca-file")
    parser.add_argument("--https-port", type=int, default=443)
    parser.add_argument("--probe-address", help="Loopback only, for isolated TLS tests; hostname verification remains enabled")
    args = parser.parse_args()
    require(1 <= args.https_port <= 65535, "Expected a valid HTTPS port")
    tool = Maintenance(args)
    if args.action == "disable":
        require(re.fullmatch(r"[0-9a-f]{40}", args.expected_commit or ""), "Disable requires the reviewed full --expected-commit")
    if args.action == "inspect":
        tool.preflight()
        record = json.loads(tool.record.read_text()) if tool.record.is_file() and not tool.record.is_symlink() else None
        if record:
            tool.owned(record)
        anchor = tool.anchor()
        print(json.dumps({"host": args.host, "proxy_id": tool.proxy["id"], "proxy_ip": tool.proxy_ip,
                          "anchor_running": bool(anchor and anchor["running"]), "record": record, "read_only": True}, indent=2))
        return
    os.umask(0o077)
    # Coordinate with the existing local release lock, without changing its flow.
    release_state = release_state_directory()
    release_state.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (release_state / ".lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        tool.preflight()
        result = tool.enable() if args.action == "enable" else tool.disable(args.expected_commit)
        print(json.dumps(result, indent=2))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("Maintenance operation failed: " + str(error), file=sys.stderr)
        sys.exit(1)
