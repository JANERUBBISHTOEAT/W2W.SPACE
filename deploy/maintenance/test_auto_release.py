#!/usr/bin/env python3
"""Real isolated auto-release integration QA. Never accesses production.

Uses a loopback-only registry, pinned nginx-proxy, synthetic Node images and a
new Redis volume per case. Failure injections are explicitly recorded. Requires
Docker, openssl and the cached images accepted by --app-image/--redis-image.
"""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import threading
import time
import traceback
from unittest.mock import patch

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from auto_release_fixture import A, B, C, Case, Images, ROOT, docker, execute, load_auto, private


def fault_worker(path):
    request = json.loads(path.read_text())
    auto = load_auto()
    state = {"used": False}
    fault = request["fault"]
    control = Path(request["control"])
    log = Path(request["fault_log"])

    def record(name, **details):
        with log.open("a") as output:
            output.write(json.dumps({"fault": fault, "event": name, **details}) + "\n")

    class FaultMaintenance(auto.Maintenance):
        def request(self, path="/health"):
            response = super().request(path)
            phase = None
            if self.record.is_file():
                phase = json.loads(self.record.read_text()).get("phase")
            if fault in ("public-once", "public-always", "retain-unverifiable") and phase == "disabling" and not self.hook.exists() and response[0] == 200:
                if fault == "public-always" or not state["used"]:
                    state["used"] = True
                    record("public verifier failure injected after real HTTPS response", actual_status=response[0], actual_body_sha256=hashlib.sha256(response[2]).hexdigest())
                    return 502, {}, b"synthetic public verification failure"
            return response

        def restore_maintenance(self, record_value, hook=None):
            result = super().restore_maintenance(record_value, hook)
            if fault == "retain-unverifiable":
                app = auto.inspect(self.args.app)
                record("synthetic inability to certify restored503", app_id=app["id"] if app else None)
                raise RuntimeError("synthetic restored503 proof unavailable")
            return result

        def remove_hook(self, record_value):
            if fault == "disable-once" and not state["used"] and json.loads(self.record.read_text()).get("phase") == "disabling":
                state["used"] = True
                record("synthetic hook-removal failure before unmask")
                raise OSError("synthetic hook removal failure")
            return super().remove_hook(record_value)

        def disable(self, expected):
            if fault == "both-crash" and not state["used"]:
                state["used"] = True
                control.write_text(json.dumps({"crash": {A: True, B: True}}))
                control.chmod(0o644)
                record("synthetic old and new app crash controls enabled")
            if fault == "asset-changed" and not state["used"]:
                state["used"] = True
                (self.assets / "index.html").write_bytes(b"operator-modified synthetic maintenance asset")
                record("owned asset deliberately modified externally")
            if fault == "postcommit-cleanup":
                original = Path.unlink
                def fail_owned_asset(path_value, *args, **kwargs):
                    if path_value == self.assets / "index.html" and not state["used"] and json.loads(self.record.read_text()).get("phase") == "disabled":
                        state["used"] = True
                        record("post-commit owned-asset unlink failure")
                        raise PermissionError("synthetic post-commit cleanup failure")
                    return original(path_value, *args, **kwargs)
                with patch.object(Path, "unlink", fail_owned_asset):
                    return super().disable(expected)
            return super().disable(expected)

    args = argparse.Namespace(**request["arguments"])
    if fault == "final-journal":
        original_journal = auto.AutoRelease.journal
        def fail_final_journal(self, phase, **fields):
            if phase == "released" and not state["used"]:
                state["used"] = True
                record("post-commit transaction journal failure")
                raise OSError("synthetic final journal unavailable")
            return original_journal(self, phase, **fields)
        auto.AutoRelease.journal = fail_final_journal
    result = auto.AutoRelease(args, maintenance_factory=FaultMaintenance).run()
    print(json.dumps(result, indent=2))
    return result["exit_code"]


def maintenance_tool(case):
    return case.module.Maintenance(case.args)


def assert_off(case, revision, image):
    case.eventually(lambda: case.normal_health(revision))
    tool = maintenance_tool(case)
    assert not tool.hook.exists() and case.module.inspect(tool.name) is None
    app = case.module.inspect(case.app)
    assert app and app["image_id"] == case.suite.images[image]["id"]
    assert case.data() == case.expected_data
    model = json.loads(case.compose("config", "--format", "json").stdout)
    default_image = model["services"]["remix"]["image"]
    assert case.docker("image", "inspect", "--format", "{{.Id}}", default_image) == case.suite.images[image]["id"]


def assert_retained(case, strict_document=True):
    tool = maintenance_tool(case)
    assert tool.hook.is_file() and tool.record.is_file()
    assert case.module.inspect(tool.name)["running"]
    if strict_document:
        case.maintenance_response("/health")
    else:
        assert case.request("/health")[0] == 503
    return json.loads(tool.record.read_text())


def check_sequence(case, first_index, old_revision, new_revision, target_image):
    items = [value for value in case.report["observations"][first_index:] if value.get("app_stable_during_request")]
    maintenance = [index for index, value in enumerate(items) if value.get("status") == 503 and value.get("maintenance_document_matches")]
    replaced = [index for index, value in enumerate(items) if value.get("app_image") == target_image]
    assert maintenance and replaced, items
    assert all("error" not in value and value.get("status") in (200,503) for value in items), items
    assert all(value.get("status") == 503 and value.get("maintenance_document_matches") for value in items if value.get("controller_phase") in ("maintenance-enabled","updater-running","rollback-running")), items
    assert all(value.get("version") == new_revision for value in items if value.get("status") == 200 and value.get("app_image") == target_image), items
    assert min(maintenance) <= min(replaced)
    assert any(value.get("status") == 200 and value.get("version") == old_revision for value in items)
    assert any(value.get("status") == 200 and value.get("version") == new_revision for value in items)
    assert all(value.get("maintenance_document_matches") for value in items if value.get("status") == 503)
    case.record_check("real TLS sequence old200 -> owned503 before replacement -> new200", old=old_revision, new=new_revision)


def successful_twice(case):
    # Source/image preparation is deliberately before auto-release starts.
    stop = threading.Event()
    def observe_build():
        while not stop.is_set():
            case.observe(); stop.wait(.2)
    observer = threading.Thread(target=observe_build, daemon=True)
    observer.start()
    try:
        case.suite.build_one("b", B, "ok")
        case.suite.build_one("c", C, "fail")
    finally:
        stop.set(); observer.join()
    assert case.report["observations"] and all(item.get("status") == 200 and item.get("version") == A for item in case.report["observations"])
    case.record_check("old application remains public200 throughout real target builds/uploads", scope="loopback fixture preparation; remote SSH bundle transport tested separately")
    start = len(case.report["observations"])
    case.observe()
    first = case.auto("b")
    case.observe()
    assert first["phase"] == "released" and first["committed"] and first["exit_code"] == 0
    assert_off(case, B, "b")
    check_sequence(case, start, A, B, case.suite.images["b"]["id"])
    case.verify_backup(first)
    case.redis_command("SET", "fixture:new", "written-under-new-B")
    case.expected_data = case.data()
    start = len(case.report["observations"])
    case.observe()
    second = case.auto("a")
    case.observe()
    assert second["phase"] == "released" and second["exit_code"] == 0 and second["committed"]
    assert first["operation_token"] != second["operation_token"]
    assert_off(case, A, "a")
    check_sequence(case, start, B, A, case.suite.images["a"]["id"])
    case.verify_backup(second)
    case.record_check("two consecutive automatic transactions and new Redis data retained")


def preflight_failure(case):
    initial = case.inspect(case.app, "{{json .Id}}")
    result = case.auto("b", changes={"revision": "not-a-full-sha"})
    assert result["exit_code"] != 0 and not result["committed"]
    assert case.inspect(case.app, "{{json .Id}}") == initial
    assert_off(case, A, "a")
    assert not any(item.get("maintenance_document_matches") for item in case.report["observations"])
    case.record_check("invalid target revision fails before enabling maintenance or changing app")


def backup_failure(case):
    initial = case.inspect(case.app, "{{json .Id}}")
    assert case.redis_command("ACL", "SETUSER", "default", "-sync", "-psync") == "OK"
    try:
        result = case.auto("b")
    finally:
        case.redis_command("ACL", "SETUSER", "default", "+sync", "+psync")
    assert result["exit_code"] != 0 and not result["committed"]
    assert case.inspect(case.app, "{{json .Id}}") == initial
    assert_off(case, A, "a")
    assert any(item.get("maintenance_document_matches") for item in case.report["observations"])
    case.record_check("real Redis SYNC permission failure restores old public application without app replacement", fault="Redis ACL on synthetic instance only; PING remains allowed")


def pull_failure(case):
    initial = case.inspect(case.app, "{{json .Id}}")
    case.suite.created  # Ensure the stopped registry remains owned for cleanup.
    docker("stop", case.suite.registry)
    try:
        result = case.auto("b")
    finally:
        docker("start", case.suite.registry)
    assert result["exit_code"] != 0 and not result["committed"]
    assert case.inspect(case.app, "{{json .Id}}") == initial
    assert_off(case, A, "a")
    case.record_check("real loopback registry connection failure leaves old app available and maintenance off")


def unhealthy_and_lock_contention(case):
    initial = case.inspect(case.app, "{{json .Id}}")
    running = case.start_auto("c")
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        item = case.observe()
        if item.get("app_image") == case.suite.images["c"]["id"] and item.get("maintenance_document_matches"):
            break
        assert running[0].poll() is None
        time.sleep(.2)
    else:
        raise AssertionError("Unhealthy candidate never ran under real maintenance")
    with (case.work / "state/.lock").open("a") as lock:
        try:fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:pass
        else:raise AssertionError("The transaction does not hold the shared lock")
    competing = case.auto("b")
    assert competing["exit_code"] != 0 and not competing["committed"]
    manual = execute(["bash", str(ROOT / "remix/update.sh"), "release", str(case.work), case.suite.images["b"]["digest"], B], env=case.env, cwd=case.work, check=False, timeout=15)
    private(case.base / "manual-lock-contender.log", manual.stdout + manual.stderr)
    assert manual.returncode != 0 and "in progress" in manual.stderr
    case.tool("enable", success=False)
    result = case.finish_auto(running)
    assert result["phase"] == "rolled-back-healthy" and result["exit_code"] != 0 and not result["committed"]
    assert_off(case, A, "a")
    case.verify_backup(result)
    assert case.inspect(case.app, "{{json .Id}}") != initial
    case.record_check("real unhealthy app rollback and full-window exclusion of second auto, manual update and manual maintenance")


def injected_recovery(case, fault, retained=False, committed=False):
    result = case.auto("b", fault=fault)
    assert (case.base / "fault-events.jsonl").is_file(), "fault was not exercised"
    events = [json.loads(line) for line in (case.base / "fault-events.jsonl").read_text().splitlines()]
    assert events
    case.report["faults"] += events
    if committed:
        assert result["committed"] and result["phase"] == "released" and result["exit_code"] == 0
        assert result["cleanup_warnings"]
        assert_off(case, B, "b")
        case.record_check("post-commit cleanup failure is a warning, preserves verified new app and never rolls it back", injection=fault)
    elif retained:
        assert result["exit_code"] != 0 and not result["committed"]
        if fault in ("asset-changed", "retain-unverifiable"):assert result["maintenance_retained"] is None
        else:assert result["maintenance_retained"]
        assert result["error"], "the original or recovery failure must not become success"
        assert_retained(case, strict_document=fault != "asset-changed")
        if fault == "asset-changed":
            tool = maintenance_tool(case)
            assert (tool.assets / "index.html").read_bytes() == b"operator-modified synthetic maintenance asset"
        if fault == "retain-unverifiable":
            assert not (Path(result["transaction_directory"]) / "update-rollback.json").exists()
            kept = [event for event in events if event["event"] == "synthetic inability to certify restored503"]
            assert kept and case.inspect(case.app, "{{json .Id}}") == kept[0]["app_id"]
            assert case.module.inspect(case.app)["image_id"] == case.suite.images["b"]["id"]
        case.record_check("unverified recovery retains actual maintenance503 and preserves failure/foreign asset evidence", injection=fault)
    else:
        assert result["phase"] == "rolled-back-healthy" and result["exit_code"] != 0 and not result["committed"]
        assert_off(case, A, "a")
        case.record_check("injected disable/public verification failure restores maintenance, then old healthy app before off", injection=fault)
    case.verify_backup(result)


def foreign_maintenance(case):
    case.tool("enable")
    tool = maintenance_tool(case)
    initial = {"record": tool.record.read_bytes(), "hook": tool.hook.read_bytes(), "asset": (tool.assets / "index.html").read_bytes(), "anchor": case.inspect(tool.name, "{{json .Id}}"), "app": case.inspect(case.app, "{{json .Id}}")}
    result = case.auto("b")
    assert result["exit_code"] != 0 and not result["committed"]
    assert tool.record.read_bytes() == initial["record"] and tool.hook.read_bytes() == initial["hook"]
    assert (tool.assets / "index.html").read_bytes() == initial["asset"]
    assert case.inspect(tool.name, "{{json .Id}}") == initial["anchor"]
    assert case.inspect(case.app, "{{json .Id}}") == initial["app"]
    case.maintenance_response()
    case.record_check("foreign/manual active maintenance is not adopted, closed, overwritten or replaced")


def child_groups(parent):
    entries = {}
    for path in Path("/proc").glob("[0-9]*/stat"):
        try:
            fields = path.read_text().rsplit(")",1)[1].split()
            entries[int(path.parent.name)] = (int(fields[1]), int(fields[2]), fields[0])
        except (OSError,ValueError,IndexError):pass
    owned = {parent}
    while True:
        before = len(owned)
        owned.update(pid for pid, value in entries.items() if value[0] in owned)
        if len(owned) == before:break
    return {entries[pid][1] for pid in owned if pid != parent and pid in entries and entries[pid][2] != "Z" and entries[pid][1] != os.getpgrp()}


def live_group(group):
    for path in Path("/proc").glob("[0-9]*/stat"):
        try:
            fields = path.read_text().rsplit(")",1)[1].split()
            if int(fields[2]) == group and fields[0] != "Z":return True
        except (OSError,ValueError,IndexError):pass
    return False


def signal_case(case, signum):
    running = case.start_auto("c")
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        item = case.observe()
        if item.get("app_image") == case.suite.images["c"]["id"] and item.get("maintenance_document_matches"):
            break
        assert running[0].poll() is None
        time.sleep(.2)
    else:
        raise AssertionError("No real updating window for signal")
    groups = child_groups(running[0].pid)
    assert groups, "Real updater child group was not observed"
    os.kill(running[0].pid, signum)
    result = case.finish_auto(running)
    assert result["exit_code"] != 0 and not result["committed"] and result["maintenance_retained"]
    assert_retained(case)
    assert not any(live_group(group) for group in groups), groups
    with (case.work / "state/.lock").open("a") as lock:fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    case.record_check("real signal during child update retains maintenance and failure state", signal=signal.Signals(signum).name, phase=result["phase"], updater_groups_reaped=sorted(groups), shared_lock_released=True)


def run_case(suite, name, function):
    case = Case(suite, name)
    error = None
    try:
        case.setup()
        function(case)
    except Exception as failure:
        error = failure
        private(case.base / "traceback.txt", traceback.format_exc())
        try:
            case.capture_failure()
        except Exception:
            pass
    finally:
        case.close_case(error)
    print(json.dumps({"case": name, "status": case.report["status"], "evidence": str(case.base), "error": str(error) if error else None}), flush=True)
    if case.report["status"] != "passed":
        raise RuntimeError("Case failed: " + name + ": " + str(error))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence-dir", type=Path, default=Path("/workspace/w2w-auto-maintenance-rehearsal"))
    parser.add_argument("--app-image", default="zheyuanwei/w2w:cfd32e77735385b8e2e7e6e13209bc60ee36e92c")
    parser.add_argument("--redis-image", default="redis:7.4-bookworm")
    parser.add_argument("--cases", help="Comma-separated exact case names; default runs the whole matrix")
    parser.add_argument("--fault-worker", type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.fault_worker:
        return fault_worker(args.fault_worker)
    os.umask(0o077)
    suite = Images(args.evidence_dir.resolve(), args.app_image, args.redis_image)
    cases = [
        ("success-twice", successful_twice), ("pre-enable-failure", preflight_failure),
        ("backup-failure", backup_failure), ("pull-failure", pull_failure),
        ("health-failure-and-locks", unhealthy_and_lock_contention),
        ("disable-failure", lambda c: injected_recovery(c, "disable-once")),
        ("public-failure-once", lambda c: injected_recovery(c, "public-once")),
        ("public-failure-retained", lambda c: injected_recovery(c, "public-always", retained=True)),
        ("both-apps-unhealthy", lambda c: injected_recovery(c, "both-crash", retained=True)),
        ("foreign-manual-maintenance", foreign_maintenance),
        ("changed-asset-retained", lambda c: injected_recovery(c, "asset-changed", retained=True)),
        ("retain-proof-failure", lambda c: injected_recovery(c, "retain-unverifiable", retained=True)),
        ("final-reporting-warning", lambda c: injected_recovery(c, "final-journal", committed=True)),
        ("postcommit-cleanup-warning", lambda c: injected_recovery(c, "postcommit-cleanup", committed=True)),
        ("sigterm-child-update", lambda c: signal_case(c, signal.SIGTERM)),
        ("sigint-child-update", lambda c: signal_case(c, signal.SIGINT)),
    ]
    selected = set(args.cases.split(",")) if args.cases else None
    if selected and not selected.issubset({name for name, function in cases}):
        parser.error("Unknown --cases name")
    source_paths = [HERE / name for name in ("auto_release.py", "maintenance.py", "index.html", "nginx.conf", "location-override.conf", "test_auto_release.py", "auto_release_fixture.py")] + [ROOT / "remix/update.sh"]
    try:
        suite.report["source_sha256"] = {str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest() for path in source_paths}
        suite.report["python"] = sys.version
        suite.setup()
        if selected and "success-twice" not in selected:
            suite.build_one("b", B, "ok"); suite.build_one("c", C, "fail")
        for name, function in cases:
            if selected is None or name in selected:
                run_case(suite, name, function)
        assert suite.report["source_sha256"] == {str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest() for path in source_paths}, "Source changed during QA; rerun final frozen source"
        suite.report["status"] = "passed"
    except Exception as error:
        suite.report.update(status="failed", error=str(error))
        private(suite.base / "traceback.txt", traceback.format_exc())
    finally:
        suite.cleanup()
        if suite.report["cleanup"]["status"] != "passed":
            suite.report["status"] = "failed"
        suite.save()
        print(json.dumps({"status": suite.report["status"], "cases": len(suite.report["cases"]), "evidence": str(suite.base / "results.json"), "error": suite.report.get("error")}), flush=True)
    return 0 if suite.report["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
