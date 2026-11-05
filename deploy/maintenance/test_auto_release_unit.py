"""Offline transaction tests: real controller, locks and maintenance file changes."""
import argparse
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shlex
import signal
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


HERE = Path(__file__).resolve().parent
with mock.patch.object(sys, "path", [str(HERE), *sys.path]):
    SPEC = importlib.util.spec_from_file_location("w2w_auto_release_unit", HERE / "auto_release.py")
    AUTO = importlib.util.module_from_spec(SPEC)
    SPEC.loader.exec_module(AUTO)
MAINTENANCE = sys.modules[AUTO.Maintenance.__module__]
OLD_REVISION, NEW_REVISION, NEXT_REVISION = "a" * 40, "b" * 40, "c" * 40
OLD_ID, NEW_ID, NEXT_ID = ["sha256:" + value * 64 for value in ("1", "2", "3")]
OLD_REF, NEW_REF, NEXT_REF = ["example/w2w@sha256:" + value * 64 for value in ("4", "5", "6")]


class Runtime:
    """Replace Docker/network boundaries, retaining real Maintenance transitions."""

    def __init__(self, compose, state):
        self.compose, self.state = compose, state
        self.images = {OLD_ID: OLD_REVISION, NEW_ID: NEW_REVISION, NEXT_ID: NEXT_REVISION}
        self.references = {OLD_REF: OLD_ID, NEW_REF: NEW_ID, NEXT_REF: NEXT_ID}
        self.image, self.reference, self.default = OLD_ID, OLD_REF, OLD_REF
        self.healthy = {image: True for image in self.images}
        self.routing = "application"
        self.anchor = None
        self.anchor_count = 0
        self.events = []
        self.updates = []
        self.fail_update = False
        self.fail_rollback = False
        self.fail_previous_health = False
        self.fail_previous_public = False
        self.fail_public_once = False
        self.fail_restore_after_public = False
        self.restore_broken = False

    def locked(self, event):
        descriptor = os.open(str(self.state / ".lock"), os.O_RDWR)
        try:
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                self.events.append(event)
            else:
                raise AssertionError("Transaction lock was not held during " + event)
        finally:
            os.close(descriptor)

    def image_id(self, reference):
        return self.references.get(reference, reference)

    def inspect(self, name):
        if name == "remix":
            return {"id": "application-container", "running": True,
                    "image_id": self.image, "image": self.reference,
                    "env": {"APP_REVISION": self.images[self.image],
                            "TRUSTED_PROXY_CIDRS": "172.18.0.2/32"}}
        if self.anchor and name in (self.anchor["name"], self.anchor["id"]):
            return self.anchor.copy()
        return None

    def docker(self, *args, **_kwargs):
        if args[:2] == ("image", "inspect"):
            image = self.image_id(args[-1])
            if image not in self.images:
                return None
            return self.images[image] if "revision" in args[-2] else image
        if args[0] == "run":
            self.locked("anchor-start")
            self.anchor_count += 1
            self.anchor = {"name": args[args.index("--name") + 1],
                           "id": "anchor-" + str(self.anchor_count), "running": True,
                           "owner": args[args.index("--label") + 1].split("=", 1)[1],
                           "image_id": MAINTENANCE.IMAGE_ID}
            return self.anchor["id"]
        if args[0] == "rm":
            self.locked("anchor-remove")
            assert self.anchor and args[-1] == self.anchor["id"]
            self.anchor = None
            return "removed"
        if args[0] == "start":
            self.locked("anchor-restart")
            assert self.anchor and args[-1] == self.anchor["id"]
            self.anchor["running"] = True
            return self.anchor["id"]
        if args[0] == "exec" and args[2] == "curl":
            return "503"
        raise AssertionError("Unexpected external Docker operation: " + repr(args[:3]))


class OfflineMaintenance(AUTO.Maintenance):
    def __init__(self, args, runtime):
        super().__init__(args)
        self.runtime = runtime

    def preflight(self):
        self.runtime.locked("maintenance-preflight")
        self.proxy = {"id": "reviewed-proxy"}
        self.proxy_ip = "172.18.0.2"
        self.network = "isolated-fixture"
        self.app = self.runtime.inspect(self.args.app)

    def regenerate(self, enabled):
        self.runtime.locked("route-maintenance" if enabled else "route-application")
        if enabled and self.runtime.restore_broken:
            raise RuntimeError("Synthetic proxy regeneration failure")
        self.runtime.routing = "maintenance" if enabled else "application"

    def app_health(self, expected):
        return self.runtime.healthy[self.runtime.image] and self.runtime.images[self.runtime.image] == expected

    def request(self, path="/health"):
        if self.runtime.routing == "maintenance":
            return 503, {"Retry-After": "120", "Cache-Control": "no-store"}, (self.assets / "index.html").read_bytes()
        revision = self.runtime.images[self.runtime.image]
        self.runtime.events.append("public-health-" + revision)
        if self.runtime.image == NEW_ID and self.runtime.fail_public_once:
            self.runtime.fail_public_once = False
            self.runtime.restore_broken = self.runtime.fail_restore_after_public
            return 502, {}, b"synthetic public health failure"
        if self.runtime.image == OLD_ID and self.runtime.fail_previous_public and "rollback" in self.runtime.updates:
            return 502, {}, b"synthetic recovered-version public failure"
        return 200, {}, json.dumps({"status": "ok", "version": revision}).encode()


class OfflineRelease(AUTO.AutoRelease):
    def __init__(self, args, runtime):
        self.runtime = runtime
        super().__init__(args, maintenance_factory=lambda options: OfflineMaintenance(options, runtime))

    def compose_image(self):
        return self.runtime.default

    def invoke_update(self, action, record=None):
        self.check_cancel()
        self.runtime.locked("update-" + action)
        self.runtime.updates.append(action)
        if action == "rollback":
            if self.runtime.fail_rollback:
                raise RuntimeError("Synthetic rollback failure")
            self.runtime.image = self.previous["image_id"]
            self.runtime.reference = self.previous["image_reference"]
            self.runtime.default = self.previous["image_reference"]
            if self.runtime.fail_previous_health:
                self.runtime.healthy[self.runtime.image] = False
            return 0, {"status": "rolled-back"}
        if self.runtime.fail_update:
            return 1, None
        self.record = Path(tempfile.mkdtemp(prefix="release-fixture-", dir=str(self.state_root)))
        for name, value in {"operation-token": self.result["operation_token"],
                            "compose-directory": str(self.tool.work),
                            "previous-image": self.previous["image_id"],
                            "previous-revision": self.previous["revision"],
                            "release-image": self.args.image, "release-revision": self.args.revision}.items():
            (self.record / name).write_text(value + "\n")
        self.result["release_record"] = str(self.record)
        self.runtime.image = self.runtime.image_id(self.args.image)
        self.runtime.reference = self.args.image
        self.runtime.default = self.args.image
        return 0, {"status": "released"}


class TransactionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="w2w-auto-release-unit-")
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.compose, self.state = self.base / "compose", self.base / "records"
        self.compose.mkdir(mode=0o700)
        self.state.mkdir(mode=0o700)
        for directory in ("vhost", "html"):
            (self.compose / directory).mkdir(mode=0o700)
        self.args = argparse.Namespace(compose_dir=str(self.compose), host="maintenance.test", proxy="proxy", app="remix",
                                       image=NEW_REF, revision=NEW_REVISION, package_root=str(HERE.parents[1]),
                                       child_timeout=10, ca_file=None, probe_address=None, https_port=443)
        self.runtime = Runtime(self.compose, self.state)
        self.environment = mock.patch.dict(os.environ, {"W2W_RELEASE_APPROVED": "1", "W2W_RELEASE_STATE_DIR": str(self.state)})
        self.environment.start()
        self.addCleanup(self.environment.stop)
        for module in (AUTO, MAINTENANCE):
            for name, replacement in (("inspect", self.runtime.inspect), ("docker", self.runtime.docker)):
                patcher = mock.patch.object(module, name, replacement)
                patcher.start()
                self.addCleanup(patcher.stop)

    def release(self, controller=OfflineRelease):
        operation = controller(self.args, self.runtime)
        return operation, operation.run()

    def assert_application(self, image):
        self.assertEqual(self.runtime.image, image)
        self.assertEqual(self.runtime.routing, "application")
        self.assertIsNone(self.runtime.anchor)
        self.assertFalse((self.compose / "vhost" / (self.args.host + "_location_override")).exists())

    def test_success_keeps_one_lock_through_enable_update_disable_and_durable_commit(self):
        operation, result = self.release()
        self.assertEqual(result["phase"], "released")
        self.assertEqual(result["exit_code"], 0)
        self.assertTrue(result["committed"])
        self.assertEqual(self.runtime.updates, ["release"])
        self.assert_application(NEW_ID)
        self.assertEqual(json.loads(operation.tool.record.read_text())["phase"], "disabled")
        self.assertEqual(json.loads((operation.transaction / "state.json").read_text())["phase"], "released")
        self.assertIn("route-maintenance", self.runtime.events)
        self.assertIn("route-application", self.runtime.events)
        with AUTO.ReleaseLock(self.state):
            pass  # No leaked lock remains after the complete transaction.

    def test_failure_before_swap_restores_verified_old_app_without_guessing_a_record(self):
        self.runtime.fail_update = True
        _, result = self.release()
        self.assertEqual(result["phase"], "rolled-back-healthy")
        self.assertEqual(result["exit_code"], 1)
        self.assertFalse(result["committed"])
        self.assertEqual(self.runtime.updates, ["release"])
        self.assertIsNone(result["release_record"])
        self.assert_application(OLD_ID)

    def test_public_target_failure_restores_503_then_rolls_back_once_and_verifies_old_public_health(self):
        self.runtime.fail_public_once = True
        _, result = self.release()
        self.assertEqual(result["phase"], "rolled-back-healthy")
        self.assertEqual(result["exit_code"], 1)
        self.assertEqual(self.runtime.updates, ["release", "rollback"])
        self.assert_application(OLD_ID)
        failed_public = self.runtime.events.index("public-health-" + NEW_REVISION)
        rollback = self.runtime.events.index("update-rollback")
        self.assertIn("route-maintenance", self.runtime.events[failed_public + 1:rollback])
        self.assertIn("public-health-" + OLD_REVISION, self.runtime.events[rollback + 1:])

    def test_unverified_maintenance_restoration_never_swaps_or_rolls_back_the_app(self):
        self.runtime.fail_public_once = True
        self.runtime.fail_restore_after_public = True
        _, result = self.release()
        self.assertNotEqual(result["exit_code"], 0)
        self.assertEqual(self.runtime.updates, ["release"])
        self.assertEqual(self.runtime.image, NEW_ID)
        self.assertIsNone(result["maintenance_retained"])

    def test_rollback_failure_is_not_retried_by_an_outer_exception_handler(self):
        self.runtime.fail_public_once = True
        self.runtime.fail_rollback = True
        _, result = self.release()
        self.assertNotEqual(result["exit_code"], 0)
        self.assertEqual(self.runtime.updates, ["release", "rollback"])
        self.assertEqual(self.runtime.routing, "maintenance")
        self.assertTrue(result["maintenance_retained"])

    def test_unhealthy_previous_runtime_after_rollback_remains_503(self):
        self.runtime.fail_public_once = True
        self.runtime.fail_previous_health = True
        _, result = self.release()
        self.assertNotEqual(result["exit_code"], 0)
        self.assertEqual(self.runtime.updates, ["release", "rollback"])
        self.assertEqual(self.runtime.image, OLD_ID)
        self.assertEqual(self.runtime.routing, "maintenance")
        self.assertTrue(result["maintenance_retained"])

    def test_previous_public_failure_after_rollback_remains_503_without_second_rollback(self):
        self.runtime.fail_public_once = True
        self.runtime.fail_previous_public = True
        _, result = self.release()
        self.assertNotEqual(result["exit_code"], 0)
        self.assertEqual(self.runtime.updates, ["release", "rollback"])
        self.assertEqual(self.runtime.routing, "maintenance")
        self.assertTrue(result["maintenance_retained"])

    def test_post_commit_asset_cleanup_warning_does_not_trigger_application_rollback(self):
        original = Path.rmdir

        def fail_public_asset_directory(path):
            if path.parent == self.compose / "html":
                raise OSError("Synthetic post-commit cleanup failure")
            return original(path)

        with mock.patch.object(Path, "rmdir", fail_public_asset_directory):
            _, result = self.release()
        self.assertEqual(result["exit_code"], 0)
        self.assertTrue(result["committed"])
        self.assertTrue(result["cleanup_warnings"])
        self.assertEqual(self.runtime.updates, ["release"])
        self.assert_application(NEW_ID)

    def test_commit_journal_failure_cannot_trigger_a_second_application_transition(self):
        class JournalFailure(OfflineRelease):
            def journal(inner, phase, **fields):
                if phase == "released":
                    raise OSError("Synthetic committed journal failure")
                return super().journal(phase, **fields)

        _, result = self.release(JournalFailure)
        self.assertTrue(result["committed"])
        self.assertEqual(self.runtime.updates, ["release"])
        self.assert_application(NEW_ID)
        self.assertTrue(result["cleanup_warnings"] or result["error"])

    def test_active_manual_maintenance_is_never_adopted_or_modified(self):
        hook = self.compose / "vhost" / (self.args.host + "_location_override")
        sentinel = b"operator-owned manual maintenance\n"
        hook.write_bytes(sentinel)
        _, result = self.release()
        self.assertNotEqual(result["exit_code"], 0)
        self.assertEqual(hook.read_bytes(), sentinel)
        self.assertEqual(self.runtime.updates, [])
        self.assertIsNone(result["operation_token"])

    def test_pending_transaction_is_not_adopted_or_overwritten(self):
        pending = self.state / ("auto-release-" + "d" * 32)
        pending.mkdir(mode=0o700)
        state = pending / "state.json"
        contents = json.dumps({"schema": "w2w-auto-release-v1", "operation_token": "d" * 32,
                               "compose_directory": str(self.compose), "host": self.args.host,
                               "phase": "updater-running"}).encode()
        state.write_bytes(contents)
        _, result = self.release()
        self.assertNotEqual(result["exit_code"], 0)
        self.assertEqual(state.read_bytes(), contents)
        self.assertEqual(self.runtime.updates, [])
        self.assertIsNone(result["operation_token"])

    def test_completed_manual_record_is_archived_without_becoming_this_operations_record(self):
        historical = OfflineMaintenance(self.args, self.runtime)
        historical.state.mkdir(mode=0o700)
        record = {"host": self.args.host, "key": historical.key, "proxy_id": "reviewed-proxy",
                  "phase": "disabled", "page_sha256": hashlib.sha256((HERE / "index.html").read_bytes()).hexdigest()}
        original = (json.dumps(record) + "\n").encode()
        historical.record.write_bytes(original)
        operation, result = self.release()
        self.assertEqual(result["exit_code"], 0)
        archived = list(self.compose.glob(historical.state.name + ".completed-*"))
        self.assertEqual(len(archived), 1)
        self.assertEqual((archived[0] / "state.json").read_bytes(), original)
        self.assertEqual(json.loads(operation.tool.record.read_text())["operation_token"], result["operation_token"])
        self.assert_application(NEW_ID)

    def test_two_successive_releases_use_distinct_ownership_records(self):
        first, first_result = self.release()
        first_state = (first.transaction / "state.json").read_bytes()
        self.args.image, self.args.revision = NEXT_REF, NEXT_REVISION
        second, second_result = self.release()
        self.assertEqual([first_result["exit_code"], second_result["exit_code"]], [0, 0])
        self.assertNotEqual(first_result["operation_token"], second_result["operation_token"])
        self.assertNotEqual(first.transaction, second.transaction)
        self.assertEqual((first.transaction / "state.json").read_bytes(), first_state)
        self.assertEqual(second_result["previous"]["image_id"], NEW_ID)
        self.assert_application(NEXT_ID)

    def test_signal_only_sets_cancellation_until_a_safe_boundary(self):
        operation = OfflineRelease(self.args, self.runtime)
        with mock.patch.object(AUTO.os, "killpg") as kill:
            operation.on_signal(signal.SIGTERM, None)
            kill.assert_not_called()
        self.assertEqual(operation.cancelled, signal.SIGTERM)
        with self.assertRaises(AUTO.InterruptedRelease):
            operation.check_cancel()
        self.assertEqual(self.runtime.updates, [])

    def test_legacy_lock_holder_prevents_any_maintenance_or_app_transition(self):
        lock = self.state / ".lock"
        descriptor = os.open(str(lock), os.O_RDWR | os.O_CREAT, 0o600)
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            _, result = self.release()
        finally:
            os.close(descriptor)
        self.assertNotEqual(result["exit_code"], 0)
        self.assertEqual(self.runtime.events, [])
        self.assertEqual(self.runtime.updates, [])

    def test_real_updater_timeout_reaps_its_process_group_before_returning_and_preserves_parent_lock(self):
        operation = OfflineRelease(self.args, self.runtime)
        operation.args.child_timeout = 0.1
        package = self.base / "child-package"
        (package / "remix").mkdir(parents=True)
        child_pid = self.base / "child.pid"
        code = "import os,sys,time;open(sys.argv[1],'w').write(str(os.getpid()));time.sleep(60)"
        (package / "remix/update.sh").write_text(
            "#!/usr/bin/env bash\n" + shlex.quote(sys.executable) + " -c " + shlex.quote(code) +
            " " + shlex.quote(str(child_pid)) + " &\nwait\n")
        operation.package = package
        operation.transaction = self.state / ("auto-release-" + "e" * 32)
        operation.transaction.mkdir(mode=0o700)
        operation.result["operation_token"] = "e" * 32
        operation.tool = OfflineMaintenance(self.args, self.runtime)
        with AUTO.ReleaseLock(self.state) as lock:
            operation.lock = lock
            with self.assertRaises(AUTO.InterruptedRelease):
                AUTO.AutoRelease.invoke_update(operation, "release")
            self.assertTrue(child_pid.is_file(), "The child really ran before timeout")
            self.assertIsNone(operation.child)
            status = Path("/proc") / child_pid.read_text().strip() / "stat"
            if status.exists():
                self.assertEqual(status.read_text().rsplit(")", 1)[1].split()[0], "Z")
            self.runtime.locked("after-timeout-child-reaped")


class UpdaterLockTests(unittest.TestCase):
    """Run update.sh's actual inherited-lock gate with a Docker sentinel executable."""

    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="w2w-updater-lock-unit-")
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)
        self.state, self.compose, binary = [self.base / name for name in ("records", "compose", "bin")]
        for path in (self.state, self.compose, binary):
            path.mkdir(mode=0o700)
        self.lock_path = self.state / ".lock"
        self.calls = self.base / "docker-calls.jsonl"
        (self.compose / ".env").write_text("W2W_IMAGE=" + OLD_REF + "\nSESSION_SECRET=synthetic-unit-only\n")
        (self.compose / ".env").chmod(0o600)
        docker = binary / "docker"
        docker.write_text("#!" + sys.executable + "\nimport json,os,sys\n"
                          "with open(os.environ['W2W_UNIT_DOCKER_CALLS'],'a') as stream: stream.write(json.dumps(sys.argv[1:])+'\\n')\n"
                          "sys.exit(0 if sys.argv[1:]==['compose','version'] else 61)\n")
        docker.chmod(0o700)
        self.environment = dict(os.environ, PATH=str(binary) + os.pathsep + os.environ.get("PATH", ""),
                                W2W_RELEASE_APPROVED="1", W2W_RELEASE_STATE_DIR=str(self.state),
                                W2W_UNIT_DOCKER_CALLS=str(self.calls))
        for key in ("W2W_RELEASE_LOCK_FD", "W2W_RELEASE_OPERATION_TOKEN", "W2W_RELEASE_RESULT_FILE", "W2W_IMAGE",
                    "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH",
                    "COMPOSE_ENV_FILES", "COMPOSE_DISABLE_ENV_FILE", "COMPOSE_FILE"):
            self.environment.pop(key, None)

    def descriptor(self, path=None, lock=None):
        descriptor = os.open(str(path or self.lock_path), os.O_RDWR | os.O_CREAT, 0o600)
        self.addCleanup(os.close, descriptor)
        if lock is not None:
            fcntl.flock(descriptor, lock | fcntl.LOCK_NB)
        return descriptor

    def run_update(self, descriptor=None, value=None, **environment):
        if self.calls.exists():
            self.calls.unlink()
        options = dict(self.environment, **environment)
        if descriptor is not None or value is not None:
            options["W2W_RELEASE_LOCK_FD"] = str(descriptor) if value is None else value
        return subprocess.run(["bash", str(HERE.parents[1] / "remix/update.sh"), "release", str(self.compose), NEW_REF, NEW_REVISION],
                              env=options, pass_fds=(() if descriptor is None else (descriptor,)),
                              capture_output=True, text=True, timeout=5)

    def assert_rejected(self, result):
        self.assertNotEqual(result.returncode, 0)
        calls = [json.loads(line) for line in self.calls.read_text().splitlines()]
        self.assertTrue(all(call == ["compose", "version"] for call in calls), calls)

    def test_held_exclusive_descriptor_is_accepted_without_unlocking_the_parent(self):
        descriptor = self.descriptor(lock=fcntl.LOCK_EX)
        result = self.run_update(descriptor)
        self.assertNotEqual(result.returncode, 0)  # The later Docker sentinel deliberately fails.
        self.assertNotIn("inherited release lock", result.stderr)
        calls = [json.loads(line) for line in self.calls.read_text().splitlines()]
        self.assertIn(["compose", "config", "--format", "json"], calls)
        probe = self.descriptor()
        with self.assertRaises(BlockingIOError):
            fcntl.flock(probe, fcntl.LOCK_SH | fcntl.LOCK_NB)

    def test_unlocked_description_is_not_a_lock_bypass(self):
        self.assert_rejected(self.run_update(self.descriptor()))

    def test_shared_description_is_rejected_without_being_upgraded(self):
        descriptor = self.descriptor(lock=fcntl.LOCK_SH)
        self.assert_rejected(self.run_update(descriptor))
        other = self.descriptor()
        fcntl.flock(other, fcntl.LOCK_SH | fcntl.LOCK_NB)

    def test_wrong_inode_description_is_rejected(self):
        self.descriptor(lock=fcntl.LOCK_EX)
        other = self.descriptor(self.state / "unrelated", lock=fcntl.LOCK_EX)
        self.assert_rejected(self.run_update(other))

    def test_replaced_lock_path_cannot_validate_an_old_description(self):
        descriptor = self.descriptor(lock=fcntl.LOCK_EX)
        self.lock_path.rename(self.state / "retained-old-lock")
        self.descriptor()
        self.assert_rejected(self.run_update(descriptor))

    def test_missing_descriptor_is_rejected(self):
        self.descriptor()
        self.assert_rejected(self.run_update(value="99"))

    def test_noncanonical_or_standard_stream_descriptors_are_rejected(self):
        self.descriptor()
        for value in ("2", "03", "-1", "invalid"):
            with self.subTest(value=value):
                self.assert_rejected(self.run_update(value=value))

    def test_group_readable_lock_is_rejected(self):
        descriptor = self.descriptor(lock=fcntl.LOCK_EX)
        self.lock_path.chmod(0o640)
        self.assert_rejected(self.run_update(descriptor))

    def test_hardlinked_lock_is_rejected(self):
        descriptor = self.descriptor(lock=fcntl.LOCK_EX)
        os.link(str(self.lock_path), str(self.state / "second-lock-name"))
        self.assert_rejected(self.run_update(descriptor))

    def test_symlink_at_lock_path_is_rejected(self):
        descriptor = self.descriptor(lock=fcntl.LOCK_EX)
        original = self.state / "original-lock"
        self.lock_path.rename(original)
        self.lock_path.symlink_to(original)
        self.assert_rejected(self.run_update(descriptor))

    def result_sink(self):
        token = "f" * 32
        parent = self.state / ("auto-release-" + token)
        parent.mkdir(mode=0o700)
        token_file = parent / "operation-token"
        token_file.write_text(token + "\n")
        token_file.chmod(0o600)
        return token, parent, parent / "update-release.json"

    def test_owned_result_sink_records_the_actual_nonzero_exit_without_environment_secrets(self):
        descriptor = self.descriptor(lock=fcntl.LOCK_EX)
        token, _, target = self.result_sink()
        result = self.run_update(descriptor, W2W_RELEASE_OPERATION_TOKEN=token, W2W_RELEASE_RESULT_FILE=str(target))
        self.assertNotEqual(result.returncode, 0)
        saved = json.loads(target.read_text())
        self.assertEqual(saved["schema"], "w2w-update-result-v1")
        self.assertEqual(saved["operation_token"], token)
        self.assertEqual(saved["action"], "release")
        self.assertEqual(saved["compose_directory"], str(self.compose))
        self.assertEqual(saved["exit_code"], result.returncode)
        self.assertIsNone(saved["release_record"])
        self.assertNotIn("synthetic-unit-only", target.read_text() + result.stdout + result.stderr)

    def test_unowned_or_existing_result_destinations_are_rejected_without_overwriting(self):
        descriptor = self.descriptor(lock=fcntl.LOCK_EX)
        token, parent, target = self.result_sink()
        token_file = parent / "operation-token"
        for kind in ("outside", "wrong-action", "wrong-token", "existing", "parent-mode", "token-mode", "token-hardlink", "token-symlink"):
            with self.subTest(kind=kind):
                parent.chmod(0o700)
                if token_file.is_symlink() or token_file.exists():
                    token_file.unlink()
                token_file.write_text(token + "\n")
                token_file.chmod(0o600)
                if target.exists():
                    target.unlink()
                selected = target
                sentinel = None
                if kind == "outside":
                    selected = self.compose / "unrelated-file"
                elif kind == "wrong-action":
                    selected = parent / "update-rollback.json"
                elif kind == "wrong-token":
                    token_file.write_text("0" * 32 + "\n")
                elif kind == "existing":
                    sentinel = b"existing operation result must survive\n"
                    target.write_bytes(sentinel)
                elif kind == "parent-mode":
                    parent.chmod(0o750)
                elif kind == "token-mode":
                    token_file.chmod(0o640)
                elif kind == "token-hardlink":
                    os.link(str(token_file), str(parent / "linked-token"))
                elif kind == "token-symlink":
                    token_file.unlink()
                    token_file.symlink_to(parent / "linked-token")
                result = self.run_update(descriptor, W2W_RELEASE_OPERATION_TOKEN=token,
                                         W2W_RELEASE_RESULT_FILE=str(selected))
                self.assert_rejected(result)
                if sentinel is not None:
                    self.assertEqual(target.read_bytes(), sentinel)

    def test_legacy_updater_contends_with_the_same_lock(self):
        self.descriptor(lock=fcntl.LOCK_EX)
        result = self.run_update()
        self.assert_rejected(result)
        self.assertIn("Another W2W release/rollback", result.stderr)


if __name__ == "__main__":
    unittest.main()
