#!/usr/bin/env python3
"""One locked, host-local maintenance/application release transaction."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import secrets
import signal
import stat
import subprocess
import sys
import tempfile
import time

from maintenance import Maintenance, atomic, docker, inspect, release_state_directory, require

HERE = Path(__file__).resolve().parent
SHA = re.compile(r"[0-9a-f]{40}\Z")
IMAGE_ID = re.compile(r"sha256:[0-9a-f]{64}\Z")
DIGEST = re.compile(r"[a-z0-9][a-z0-9./:_-]*@sha256:[0-9a-f]{64}\Z")
TERMINAL = {"released", "rolled-back-healthy", "enable-failed-restored", "preflight-failed"}


def local_environment():
    result = dict(os.environ)
    for name in ("DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH", "W2W_IMAGE"):
        result.pop(name, None)
    result["DOCKER_HOST"] = "unix:///var/run/docker.sock"
    return result


def protected(info):
    return (stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and
            info.st_uid == os.geteuid() and not stat.S_IMODE(info.st_mode) & 0o077)


class ReleaseLock:
    def __init__(self, directory):
        self.directory = directory
        self.fd = None

    def __enter__(self):
        require(not self.directory.is_symlink(), "Refusing a symbolic release state directory")
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.directory = self.directory.resolve()
        info = self.directory.stat()
        require(info.st_uid == os.geteuid() and not stat.S_IMODE(info.st_mode) & 0o077,
                "Release state directory must remain private to its operator")
        self.fd = os.open(str(self.directory / ".lock"), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            require(protected(os.fstat(self.fd)), "Expected the protected release lock file")
            fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BaseException:
            os.close(self.fd)
            self.fd = None
            raise
        return self

    def __exit__(self, *_):
        # Never LOCK_UN an inherited open file description: a child may still
        # own it after SIGKILL. Closing this reference preserves the child's lock.
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None


class InterruptedRelease(Exception):
    pass


class AutoRelease:
    def __init__(self, args, maintenance_factory=None):
        self.args = args
        self.factory = maintenance_factory
        self.tool = None
        self.lock = None
        self.child = None
        self.cancelled = None
        self.finished_transition = False
        self.transaction = None
        self.previous = None
        self.record = None
        self.state_root = release_state_directory()
        self.package = Path(getattr(args, "package_root", None) or HERE.parents[1])
        self.result = {
            "schema": "w2w-auto-release-v1", "phase": "preflight-failed", "exit_code": 1,
            "committed": False, "operation_token": None, "transaction_directory": None,
            "release_record": None, "maintenance_record": None, "maintenance_retained": False,
            "compose_directory": str(args.compose_dir), "host": args.host,
            "requested_image": args.image, "requested_revision": args.revision,
            "previous": None, "cleanup_warnings": [], "error": None,
        }

    def journal(self, phase, **fields):
        self.result.update(fields)
        self.result["phase"] = phase
        if self.transaction:
            atomic(self.transaction / "state.json", (json.dumps(self.result, indent=2) + "\n").encode())

    def on_signal(self, number, _frame):
        # No asynchronous exception may cross Maintenance.disable's unmask/
        # verification/commit section. Observe cancellation at safe boundaries.
        self.cancelled = number
        if self.child and self.child.poll() is None:
            try:
                os.killpg(self.child.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass

    def check_cancel(self):
        if self.cancelled:
            raise InterruptedRelease("Release interrupted; inspect the retained maintenance transaction")

    def validate(self):
        require(os.environ.get("W2W_RELEASE_APPROVED") == "1", "Automatic release requires W2W_RELEASE_APPROVED=1")
        require(SHA.fullmatch(self.args.revision or ""), "Expected the full verified release commit")
        require(DIGEST.fullmatch(self.args.image or ""), "Expected an immutable release image digest")
        require(self.package.is_absolute() and not self.package.is_symlink() and self.package.is_dir(), "Expected the verified private source package")
        require(self.package.resolve() == HERE.parents[1], "Package root must be this coordinator's verified source bundle")
        for name in ("deploy/maintenance/auto_release.py", "deploy/maintenance/maintenance.py", "deploy/maintenance/index.html",
                     "deploy/maintenance/nginx.conf", "deploy/maintenance/location-override.conf", "remix/update.sh"):
            source = self.package / name
            require(source.is_file() and not source.is_symlink(), "A required regular bundle source is missing")
        require(float(getattr(self.args, "child_timeout", 900)) > 0, "Expected a positive child timeout")
        work = Path(self.args.compose_dir)
        require(work.is_absolute() and work.is_dir() and not work.is_symlink(), "Expected the confirmed regular Compose directory")
        self.args.compose_dir = str(work.resolve())
        self.result["compose_directory"] = self.args.compose_dir

    def compose_image(self):
        process = subprocess.run(["docker", "--host=unix:///var/run/docker.sock", "compose", "config", "--format", "json"],
                                 cwd=str(self.tool.work), env=local_environment(), capture_output=True, text=True, timeout=30)
        require(process.returncode == 0, "Default Compose configuration could not be verified")
        # Never retain or print the complete model: it contains runtime secrets.
        return json.loads(process.stdout)["services"]["remix"]["image"]

    def snapshot(self):
        app = inspect(self.args.app)
        require(app and app["running"] and IMAGE_ID.fullmatch(app["image_id"]), "A running previous application is required")
        revision = docker("image", "inspect", "--format", '{{index .Config.Labels "org.opencontainers.image.revision"}}', app["image_id"])
        require(SHA.fullmatch(revision), "Automatic recovery requires a versioned previous application")
        reference = app["image_id"]
        candidate = app["image"]
        if DIGEST.fullmatch(candidate) and docker("image", "inspect", "--format", "{{.Id}}", candidate, optional=True) == reference:
            reference = candidate
        return {"image_id": app["image_id"], "image_reference": reference, "revision": revision,
                "default_image": self.compose_image()}

    def reject_pending(self):
        for attempt in self.state_root.glob("auto-release-*"):
            require(not attempt.is_symlink() and attempt.is_dir(), "Unexpected automatic release transaction path")
            state = attempt / "state.json"
            require(state.is_file() and not state.is_symlink(), "An incomplete automatic release transaction needs inspection")
            data = json.loads(state.read_text())
            require(re.fullmatch(r"auto-release-[0-9a-f]{32}", attempt.name) and
                    data.get("schema") == "w2w-auto-release-v1" and
                    data.get("operation_token") == attempt.name[len("auto-release-"):] and
                    isinstance(data.get("compose_directory"), str) and Path(data["compose_directory"]).is_absolute() and
                    isinstance(data.get("host"), str), "An automatic release journal has an invalid identity")
            if data.get("compose_directory") == str(self.tool.work) and data.get("host") == self.args.host:
                require(data.get("phase") in TERMINAL, "An unfinished automatic release needs manual recovery")
        require(not self.tool.hook.exists() and not self.tool.hook.is_symlink() and self.tool.anchor() is None,
                "Existing maintenance must not be taken over by an automatic release")
        if self.tool.state.exists():
            require(self.tool.record.is_file() and not self.tool.record.is_symlink(), "Existing maintenance state needs manual inspection")
            record = json.loads(self.tool.record.read_text())
            self.tool.owned(record, check_operation=False)
            require(record.get("phase") in ("disabled", "enable-failed-restored"),
                    "Active or incomplete maintenance state cannot be taken over")

    def owned_maintenance(self):
        require(self.tool.record.is_file() and not self.tool.record.is_symlink(), "Owned maintenance recovery record is unavailable")
        record = json.loads(self.tool.record.read_text())
        self.tool.owned(record)
        return record

    def retain(self):
        try:
            self.tool.restore_maintenance(self.owned_maintenance())
            self.result["maintenance_retained"] = True
        except Exception:
            # The failure may be the public probe itself. Retain all ownership
            # evidence and report unverified, never claim a successful mode swap.
            self.result["maintenance_retained"] = None

    def previous_healthy(self, unchanged_default=False):
        try:
            current = inspect(self.args.app)
            if not current or current["image_id"] != self.previous["image_id"] or not self.tool.app_health(self.previous["revision"]):
                return False
            default = self.compose_image()
            if unchanged_default and default == self.previous["default_image"]:
                return True
            return docker("image", "inspect", "--format", "{{.Id}}", default, optional=True) == self.previous["image_id"]
        except Exception:
            return False

    @staticmethod
    def living_group(group):
        # Linux process groups may retain reparented zombies after SIGKILL; they
        # cannot mutate. A live descendant must be reaped/terminated before lock
        # release or any recovery operation starts.
        for path in Path("/proc").glob("[0-9]*/stat"):
            try:
                fields = path.read_text().rsplit(")", 1)[1].split()
                if int(fields[2]) == group and fields[0] != "Z":
                    return True
            except (OSError, ValueError, IndexError):
                continue
        return False

    def stop_child(self):
        child = self.child
        if not child:
            return
        try:
            os.killpg(child.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        child.wait()
        while self.living_group(child.pid):
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            time.sleep(0.1)

    def invoke_update(self, action, record=None):
        self.check_cancel()
        output = self.transaction / ("update-" + action + ".json")
        require(not output.exists() and not output.is_symlink(), "An updater result already exists for this transaction")
        environment = local_environment()
        environment.update({"W2W_RELEASE_APPROVED": "1", "W2W_RELEASE_STATE_DIR": str(self.state_root),
                            "W2W_RELEASE_LOCK_FD": str(self.lock.fd), "W2W_RELEASE_OPERATION_TOKEN": self.result["operation_token"],
                            "W2W_RELEASE_RESULT_FILE": str(output)})
        command = ["bash", str(self.package / "remix/update.sh"), action, str(self.tool.work)]
        command += [self.args.image, self.args.revision] if action == "release" else [str(record)]
        self.journal("updater-running" if action == "release" else "rollback-running")
        self.child = subprocess.Popen(command, env=environment, cwd=str(self.tool.work), pass_fds=(self.lock.fd,),
                                      start_new_session=True, stdin=subprocess.DEVNULL, stdout=2, stderr=2)
        deadline = time.monotonic() + float(getattr(self.args, "child_timeout", 900))
        try:
            while self.child.poll() is None:
                if self.cancelled or time.monotonic() >= deadline:
                    self.stop_child()
                    raise InterruptedRelease("Updater interrupted or timed out; daemon outcome requires manual inspection")
                try:
                    self.child.wait(timeout=0.2)
                except subprocess.TimeoutExpired:
                    pass
            exit_code = self.child.returncode
            # A shell can exit while a mutating descendant is still alive.
            if self.living_group(self.child.pid):
                self.stop_child()
                raise InterruptedRelease("Updater left live descendants; outcome requires manual inspection")
        except BaseException:
            if self.child and (self.child.poll() is None or self.living_group(self.child.pid)):
                self.stop_child()
            raise
        finally:
            if self.child and (self.child.poll() is None or self.living_group(self.child.pid)):
                self.stop_child()
            self.child = None
        self.check_cancel()
        if not output.is_file() or output.is_symlink():
            require(exit_code != 0, "Successful updater omitted its owned result")
            return exit_code, None
        data = json.loads(output.read_text())
        require(data.get("schema") == "w2w-update-result-v1" and data.get("operation_token") == self.result["operation_token"] and
                data.get("action") == action and data.get("compose_directory") == str(self.tool.work) and data.get("exit_code") == exit_code,
                "Updater result identity does not match this operation")
        record_path = data.get("release_record")
        if record_path:
            candidate = Path(record_path)
            require(candidate.is_absolute() and candidate.parent == self.state_root and not candidate.is_symlink() and candidate.is_dir(),
                    "Updater returned an unexpected release record path")
            require((candidate / "operation-token").read_text().strip() == self.result["operation_token"] and
                    (candidate / "compose-directory").read_text().strip() == str(self.tool.work) and
                    (candidate / "previous-image").read_text().strip() == self.previous["image_id"] and
                    (candidate / "previous-revision").read_text().strip() == self.previous["revision"] and
                    (candidate / "release-revision").read_text().strip() == self.args.revision and
                    (candidate / "release-image").read_text().strip() == self.args.image,
                    "Release record is not this operation's exact application transition")
            if self.record:
                require(candidate == self.record, "Rollback returned a different release record")
            self.record = candidate
            self.result["release_record"] = str(candidate)
        return exit_code, data

    def finish(self, phase, exit_code, expected):
        self.check_cancel()
        self.owned_maintenance()
        self.journal("maintenance-disabling")
        restored = self.tool.disable(expected)
        # Public exact-version verification + durable maintenance commit have
        # completed. No later logging/cleanup/transport failure may roll back.
        self.finished_transition = True
        self.result.update({"phase": phase, "exit_code": exit_code, "committed": phase == "released", "maintenance_retained": False})
        if restored.get("cleanup_warning"):
            self.result["cleanup_warnings"].append(restored["cleanup_warning"])
        try:
            self.journal(phase)
        except OSError:
            self.result["cleanup_warnings"].append("Verified routing committed; transaction journal needs inspection")
        return self.result

    def recover(self):
        self.check_cancel()
        self.retain()
        require(self.result["maintenance_retained"] is True, "Maintenance 503 did not verify; no application recovery will be attempted")
        if not self.previous_healthy(unchanged_default=self.record is None):
            require(self.record is not None, "No exact owned release record is available for automatic rollback")
            code, _ = self.invoke_update("rollback", self.record)
            require(code == 0 and self.previous_healthy(), "The previous image/default did not recover healthy")
        self.check_cancel()
        return self.finish("rolled-back-healthy", 1, self.previous["revision"])

    def run_locked(self):
        token = secrets.token_hex(16)
        self.args.operation_token = token
        self.tool = (self.factory or Maintenance)(self.args)
        self.tool.preflight()
        self.reject_pending()
        self.previous = self.snapshot()
        require(self.tool.app_health(self.previous["revision"]), "The previous application's internal version is not healthy")
        self.check_cancel()
        self.transaction = Path(tempfile.mkdtemp(prefix="auto-release-", dir=str(self.state_root)))
        # A fixed token-named directory lets update.sh validate its result sink
        # without accepting an arbitrary output path or copying environment data.
        target = self.state_root / ("auto-release-" + token)
        self.transaction.rename(target)
        self.transaction = target
        atomic(target / "operation-token", (token + "\n").encode())
        self.result.update({"operation_token": token, "transaction_directory": str(target), "previous": self.previous,
                            "maintenance_record": str(self.tool.record)})
        self.journal("maintenance-enabling")
        try:
            self.tool.enable()
        except Exception:
            self.check_cancel()
            if self.previous_healthy(unchanged_default=True) and not self.tool.hook.exists() and self.tool.anchor() is None:
                self.tool.verify_public(self.previous["revision"])
                self.finished_transition = True
                self.result.update({"phase": "enable-failed-restored", "exit_code": 1,
                                    "error": "Maintenance enable failed; the previous application remains verified"})
                try:
                    self.journal("enable-failed-restored")
                except OSError:
                    self.result["cleanup_warnings"].append("Previous routing verified; transaction journal needs inspection")
                return self.result
            raise
        self.result["maintenance_retained"] = True
        self.journal("maintenance-enabled")
        self.check_cancel()
        try:
            code, data = self.invoke_update("release")
            if code == 0:
                require(self.record is not None and data.get("status") == "released", "Updater did not durably confirm the requested release")
                require(self.tool.app_health(self.args.revision), "Requested app internal version did not verify")
                app = inspect(self.args.app)
                require(app and app["image_id"] == docker("image", "inspect", "--format", "{{.Id}}", self.args.image) and
                        self.compose_image() == self.args.image, "Requested runtime image/default did not match the verified release")
                return self.finish("released", 0, self.args.revision)
        except InterruptedRelease:
            raise
        except Exception:
            if self.finished_transition:
                raise
        # Recovery is outside the protected release try. Its own failure must
        # not cause a second rollback or reuse the updater result reservation.
        return self.recover()

    def run(self):
        old_handlers = {}
        try:
            self.validate()
            for number in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
                old_handlers[number] = signal.signal(number, self.on_signal)
            with ReleaseLock(self.state_root) as lock:
                self.lock = lock
                self.state_root = lock.directory
                try:
                    return self.run_locked()
                except InterruptedRelease:
                    # Child has been reaped, but an accepted Docker request can
                    # still finish in the daemon. Do not guess or unmask here.
                    if self.transaction:
                        self.retain()
                    self.result["error"] = "Interrupted transaction: inspect actual Docker/record state before application recovery"
                    self.journal("interrupted-maintenance-retained", exit_code=1)
                    return self.result
                except Exception:
                    if self.finished_transition:
                        return self.result
                    if self.transaction:
                        self.retain()
                        self.result["error"] = "Automatic release failed; inspect the owned transaction and retained maintenance before recovery"
                        self.journal("maintenance-retained", exit_code=1)
                    else:
                        self.result["error"] = "Automatic release preflight failed; no maintenance or application transition was started"
                    return self.result
                finally:
                    if self.child and (self.child.poll() is None or self.living_group(self.child.pid)):
                        self.stop_child()
        except Exception:
            if self.finished_transition:
                self.result["cleanup_warnings"].append("Verified routing committed; final transaction reporting needs inspection")
                return self.result
            if self.transaction:
                self.result.update({"phase": "maintenance-retained", "exit_code": 1,
                                    "maintenance_retained": None,
                                    "error": "Transaction outcome/reporting is uncertain; inspect the owned state before recovery"})
            else:
                self.result["error"] = "Automatic release approval, package or exclusive-lock preflight failed"
            return self.result
        finally:
            if self.child and (self.child.poll() is None or self.living_group(self.child.pid)):
                self.stop_child()
            for number, handler in old_handlers.items():
                signal.signal(number, handler)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--compose-dir", required=True)
    parser.add_argument("--host", required=True)
    parser.add_argument("--image", required=True)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--package-root", default=str(HERE.parents[1]))
    parser.add_argument("--proxy", default="nginx-proxy")
    parser.add_argument("--app", default="remix")
    parser.add_argument("--child-timeout", type=float, default=900)
    parser.add_argument("--ca-file")
    parser.add_argument("--probe-address")
    parser.add_argument("--https-port", type=int, default=443)
    args = parser.parse_args()
    require(1 <= args.https_port <= 65535, "Expected a valid HTTPS port")
    os.umask(0o077)
    result = AutoRelease(args).run()
    print(json.dumps(result, sort_keys=True))
    return result["exit_code"]


if __name__ == "__main__":
    sys.exit(main())
