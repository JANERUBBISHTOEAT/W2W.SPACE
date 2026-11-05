#!/usr/bin/env python3
"""Offline source-bundle trust-boundary tests; no Docker, SSH or network.

Temporary Git repositories exercise immutable blob packaging. Handcrafted tar
inputs exercise the receiver with newly computed outer hashes, so rejection
cannot be explained solely by a stale outer checksum.
"""
import copy
import gzip
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shlex
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest import mock

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
EXPECTED_FILES = (
    "deploy/maintenance/auto_release.py",
    "deploy/maintenance/maintenance.py",
    "deploy/maintenance/index.html",
    "deploy/maintenance/nginx.conf",
    "deploy/maintenance/location-override.conf",
    "remix/update.sh",
)
REJECTIONS = (RuntimeError, ValueError, TypeError, OSError, tarfile.TarError, EOFError)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def load_tool(name):
    module_name = "w2w_release_bundle_test_" + name
    spec = importlib.util.spec_from_file_location(module_name, HERE / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


def git(repo, *args):
    environment = dict(os.environ)
    environment.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull,
                       GIT_TERMINAL_PROMPT="0", LC_ALL="C")
    process = subprocess.run(["git", "-C", str(repo), *args], env=environment,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)
    if process.returncode:
        raise AssertionError("Local Git fixture setup failed: " + " ".join(args[:2]))
    return process.stdout.decode().strip()


def commit(repo):
    git(repo, "add", "--all")
    git(repo, "-c", "user.name=Bundle fixture", "-c", "user.email=bundle-fixture@invalid",
        "-c", "commit.gpgsign=false", "commit", "--quiet", "--no-gpg-sign", "-m", "Local fixture")
    return git(repo, "rev-parse", "HEAD")


def make_repo(directory):
    repo = directory / "repo"
    repo.mkdir()
    git(repo, "init", "--quiet")
    for name in EXPECTED_FILES:
        path = repo / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(("Public fixture: " + name + "\n$Format:%H$\n").encode())
        path.chmod(0o644)
    return repo, commit(repo)


def unpack(data):
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:") as archive:
        return [(copy.copy(member), archive.extractfile(member).read() if member.isfile() else b"")
                for member in archive.getmembers()]


def pack(entries, *, archive_format=tarfile.USTAR_FORMAT):
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode="w:", format=archive_format) as archive:
        for member, contents in entries:
            member = copy.copy(member)
            if member.isfile():
                member.size = len(contents)
            archive.addfile(member, io.BytesIO(contents) if member.isfile() else None)
    return stream.getvalue()


class PackageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.package = load_tool("package")

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="w2w-bundle-package-unit-")
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.repo, self.revision = make_repo(self.directory)
        self.output = self.directory / "release.tar"

    def build(self, revision=None, output=None):
        return self.package.build_bundle(self.repo, self.revision if revision is None else revision,
                                         self.output if output is None else output)

    def test_exact_public_allowlist_excludes_tracked_secrets_and_unrelated_files(self):
        unrelated = {".env": b"SYNTHETIC_SECRET_NOT_FOR_RELEASE", "id_ed25519": b"SYNTHETIC_PRIVATE_KEY",
                     "deploy/maintenance/private.pem": b"SYNTHETIC_PRIVATE_CERT",
                     "unrelated.txt": b"not part of the release helper source"}
        for name, contents in unrelated.items():
            (self.repo / name).write_bytes(contents)
        self.revision = commit(self.repo)
        metadata = self.build()
        data = self.output.read_bytes()
        entries = unpack(data)
        self.assertEqual(set(self.package.ALLOWED_FILES), set(EXPECTED_FILES))
        self.assertEqual({member.name for member, _ in entries}, {"manifest.json", *EXPECTED_FILES})
        self.assertEqual(len(entries), len(EXPECTED_FILES) + 1)
        for contents in unrelated.values():
            self.assertNotIn(contents, data)
        manifest_bytes = dict((member.name, contents) for member, contents in entries)["manifest.json"]
        manifest = json.loads(manifest_bytes)
        self.assertEqual(manifest["revision"], self.revision)
        self.assertEqual(manifest["protocol"], 1)
        self.assertEqual(set(manifest["files"]), set(EXPECTED_FILES))
        self.assertEqual(metadata, {"revision": self.revision, "archive_sha256": digest(data),
                                    "manifest_sha256": digest(manifest_bytes), "archive_bytes": len(data)})

    def test_reproducible_ustar_headers_and_manifest_match_git_blob_modes(self):
        (self.repo / "remix/update.sh").chmod(0o755)
        self.revision = commit(self.repo)
        first = self.build()
        other = self.directory / "second.tar"
        self.assertEqual(self.build(output=other), first)
        data = self.output.read_bytes()
        self.assertEqual(data, other.read_bytes())
        entries = unpack(data)
        manifest = json.loads(dict((member.name, contents) for member, contents in entries)["manifest.json"])
        for member, contents in entries:
            self.assertTrue(member.isfile())
            self.assertEqual((member.uid, member.gid, member.mtime), (0, 0, 0))
            self.assertFalse(member.pax_headers)
            if member.name != "manifest.json":
                expected_mode = 0o755 if member.name == "remix/update.sh" else 0o644
                self.assertEqual(member.mode, expected_mode)
                self.assertEqual(manifest["files"][member.name],
                                 {"sha256": digest(contents), "size": len(contents), "mode": expected_mode})
        self.assertEqual(data[257:263], b"ustar\x00")

    def test_git_export_subst_attributes_cannot_rewrite_public_source(self):
        (self.repo / ".gitattributes").write_text("deploy/maintenance/index.html export-subst\n")
        self.revision = commit(self.repo)
        self.build()
        files = dict((member.name, contents) for member, contents in unpack(self.output.read_bytes()))
        self.assertIn(b"$Format:%H$", files["deploy/maintenance/index.html"])
        self.assertEqual(files["deploy/maintenance/index.html"], (self.repo / "deploy/maintenance/index.html").read_bytes())

    def test_non_full_or_non_lowercase_revisions_are_refused_without_output(self):
        for revision in ("", "HEAD", self.revision[:12], "a" * 39, "a" * 41, "G" * 40,
                         self.revision.upper(), self.revision + "\n"):
            with self.subTest(revision=revision), self.assertRaises(REJECTIONS):
                self.build(revision)
            self.assertFalse(self.output.exists())

    def test_a_different_valid_full_revision_is_refused(self):
        with self.assertRaises(REJECTIONS):
            self.build("a" * 40 if self.revision != "a" * 40 else "b" * 40)
        self.assertFalse(self.output.exists())

    def test_dirty_tracked_bytes_are_not_packaged(self):
        (self.repo / EXPECTED_FILES[0]).write_bytes(b"unreviewed working tree program")
        with self.assertRaises(REJECTIONS):
            self.build()
        self.assertFalse(self.output.exists())

    def test_untracked_sensitive_file_blocks_packaging(self):
        (self.repo / ".env").write_text("SYNTHETIC_UNTRACKED_SECRET")
        with self.assertRaises(REJECTIONS):
            self.build()
        self.assertFalse(self.output.exists())

    def test_committed_source_symlink_is_refused(self):
        public_file = self.repo / EXPECTED_FILES[0]
        public_file.unlink()
        public_file.symlink_to("../../outside-private-key")
        self.revision = commit(self.repo)
        with self.assertRaises(REJECTIONS):
            self.build()
        self.assertFalse(self.output.exists())

    def test_committed_parent_symlink_does_not_authorize_external_source(self):
        shutil.rmtree(self.repo / "remix")
        external = self.directory / "outside"
        external.mkdir()
        (external / "update.sh").write_text("outside the verified Git tree")
        (self.repo / "remix").symlink_to(external, target_is_directory=True)
        self.revision = commit(self.repo)
        with self.assertRaises(REJECTIONS):
            self.build()
        self.assertFalse(self.output.exists())

    def test_existing_output_or_symlink_is_never_replaced(self):
        self.output.write_bytes(b"existing transport evidence")
        with self.assertRaises(REJECTIONS):
            self.build()
        self.assertEqual(self.output.read_bytes(), b"existing transport evidence")
        self.output.unlink()
        sentinel = self.directory / "unrelated"
        sentinel.write_bytes(b"private fixture sentinel")
        self.output.symlink_to(sentinel)
        with self.assertRaises(REJECTIONS):
            self.build()
        self.assertTrue(self.output.is_symlink())
        self.assertEqual(sentinel.read_bytes(), b"private fixture sentinel")

    def test_checkout_change_during_blob_reads_blocks_writing_a_bundle(self):
        original_git = self.package.git
        changed = False

        def changing_git(repo, *args):
            nonlocal changed
            data = original_git(repo, *args)
            if args[:2] == ("cat-file", "blob") and not changed:
                changed = True
                (self.repo / EXPECTED_FILES[0]).write_text("Changed during packaging")
            return data

        with mock.patch.object(self.package, "git", side_effect=changing_git), self.assertRaises(REJECTIONS):
            self.build()
        self.assertTrue(changed)
        self.assertFalse(self.output.exists())


class BootstrapTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.package = load_tool("package")
        cls.bootstrap = load_tool("bootstrap")
        cls.fixture = tempfile.TemporaryDirectory(prefix="w2w-bundle-receiver-unit-")
        cls.addClassCleanup(cls.fixture.cleanup)
        cls.fixture_root = Path(cls.fixture.name)
        cls.repo, cls.revision = make_repo(cls.fixture_root)
        output = cls.fixture_root / "release.tar"
        cls.metadata = cls.package.build_bundle(cls.repo, cls.revision, output)
        cls.archive = output.read_bytes()
        cls.entries = unpack(cls.archive)
        cls.manifest_bytes = dict((member.name, contents) for member, contents in cls.entries)["manifest.json"]
        cls.manifest = json.loads(cls.manifest_bytes)

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="w2w-bundle-stage-unit-")
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)

    def inspect(self, data=None, **pins):
        data = self.archive if data is None else data
        return self.bootstrap.inspect_bundle(data, revision=pins.get("revision", self.revision),
            archive_sha256=pins.get("archive_sha256", digest(data)),
            manifest_sha256=pins.get("manifest_sha256", digest(self.manifest_bytes)))

    def reject(self, data, **pins):
        # No malformed archive is allowed to dispatch maintenance/application work.
        with mock.patch.object(self.bootstrap.os, "execve", side_effect=AssertionError("No dispatch during validation")), \
             mock.patch.object(self.bootstrap.os, "dup2", side_effect=AssertionError("No FD changes during validation")):
            with self.assertRaises(REJECTIONS):
                self.inspect(data, **pins)

    def replace_manifest(self, manifest):
        encoded = json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()
        if self.manifest_bytes.endswith(b"\n"):
            encoded += b"\n"
        return self.replace_manifest_bytes(encoded)

    def replace_manifest_bytes(self, encoded):
        entries = [(member, encoded if member.name == "manifest.json" else contents)
                   for member, contents in self.entries]
        return pack(entries), digest(encoded)

    def test_valid_bundle_returns_only_pinned_manifest_and_allowed_public_bytes(self):
        self.assertEqual(set(self.bootstrap.ALLOWED_FILES), set(EXPECTED_FILES))
        verified = self.inspect()
        self.assertEqual(verified["manifest"], self.manifest)
        self.assertEqual(set(verified["files"]), {"manifest.json", *EXPECTED_FILES})
        self.assertEqual(verified["files"]["manifest.json"], self.manifest_bytes)
        for name in EXPECTED_FILES:
            self.assertIsInstance(verified["files"][name], bytes)
            self.assertEqual(verified["files"][name], (self.repo / name).read_bytes())

    def test_bad_outer_archive_pin_or_manifest_pin_is_rejected(self):
        for pin in ("archive_sha256", "manifest_sha256"):
            for value in ("0" * 64, "abc", "G" * 64, "A" * 64, "a" * 63, "a" * 65, "a" * 64 + "\n"):
                with self.subTest(pin=pin, value=value):
                    self.reject(self.archive, **{pin: value})

    def test_revision_format_and_manifest_revision_must_match_expected(self):
        for revision in (self.revision[:12], "HEAD", "G" * 40, self.revision.upper(), self.revision + "\n", "b" * 40):
            with self.subTest(revision=revision):
                self.reject(self.archive, revision=revision)

    def test_changed_member_is_rejected_even_with_recomputed_outer_hash(self):
        entries = [(member, contents + b"unreviewed change" if member.name == EXPECTED_FILES[0] else contents)
                   for member, contents in self.entries]
        self.reject(pack(entries))

    def test_changed_manifest_is_rejected_even_with_recomputed_outer_hash(self):
        changed = copy.deepcopy(self.manifest)
        changed["revision"] = "b" * 40
        archive, _ = self.replace_manifest(changed)
        self.reject(archive)

    def test_manifest_cannot_authorize_extra_members_or_missing_allowlisted_members(self):
        variants = []
        extra = copy.deepcopy(self.manifest)
        extra["files"][".env"] = {"sha256": digest(b"synthetic"), "size": 9, "mode": 0o644}
        variants.append(extra)
        missing = copy.deepcopy(self.manifest)
        del missing["files"][EXPECTED_FILES[0]]
        variants.append(missing)
        for manifest in variants:
            with self.subTest(files=list(manifest["files"])):
                archive, manifest_sha = self.replace_manifest(manifest)
                self.reject(archive, manifest_sha256=manifest_sha)

    def test_manifest_fields_are_strictly_typed_and_bounded(self):
        variants = []
        for key, value in (("protocol", 2), ("protocol", True), ("revision", "b" * 40), ("files", [])):
            item = copy.deepcopy(self.manifest)
            item[key] = value
            variants.append(item)
        for key, value in (("size", -1), ("size", True), ("size", 1.0), ("size", "1"),
                           ("size", self.bootstrap.MAX_MEMBER_BYTES + 1), ("sha256", "x" * 64),
                           ("sha256", "A" * 64), ("mode", 0o600), ("mode", "420")):
            item = copy.deepcopy(self.manifest)
            item["files"][EXPECTED_FILES[0]][key] = value
            variants.append(item)
        for item in variants:
            with self.subTest(manifest=item):
                archive, manifest_sha = self.replace_manifest(item)
                self.reject(archive, manifest_sha256=manifest_sha)

    def test_duplicate_json_keys_and_noncanonical_manifest_are_rejected(self):
        duplicate = self.manifest_bytes.replace(b'"protocol":1', b'"protocol":1,"protocol":1')
        self.assertNotEqual(duplicate, self.manifest_bytes)
        pretty = json.dumps(self.manifest, sort_keys=True, indent=2).encode()
        for data in (duplicate, pretty, b"[]", b"null", b"{bad json}"):
            with self.subTest(manifest=data[:40]):
                archive, manifest_sha = self.replace_manifest_bytes(data)
                self.reject(archive, manifest_sha256=manifest_sha)

    def test_duplicate_manifest_or_payload_members_are_rejected(self):
        for member_name in ("manifest.json", EXPECTED_FILES[0]):
            duplicate = next(entry for entry in self.entries if entry[0].name == member_name)
            with self.subTest(member=member_name):
                self.reject(pack([*self.entries, duplicate]))

    def test_extra_or_missing_members_are_rejected(self):
        member = tarfile.TarInfo("unrelated-public-file.txt")
        member.mode = 0o644
        self.reject(pack([*self.entries, (member, b"not authorized by the fixed source allowlist")]))
        for omitted in ("manifest.json", EXPECTED_FILES[0]):
            with self.subTest(omitted=omitted):
                self.reject(pack([entry for entry in self.entries if entry[0].name != omitted]))

    def test_noncanonical_names_and_path_traversal_are_rejected(self):
        first = EXPECTED_FILES[0]
        names = ["/" + first, "../" + first, "./" + first, "deploy//maintenance/auto_release.py",
                 "deploy/unused/../maintenance/auto_release.py", first + "/", first.replace("/", "\\"),
                 "deploy/maintenance", "manifest.json/child", "C:/" + first]
        for name in names:
            entries = copy.deepcopy(self.entries)
            member, contents = next(entry for entry in entries if entry[0].name == first)
            member.name = name
            with self.subTest(name=name):
                self.reject(pack(entries))
        self.assertFalse((self.directory.parent / "auto_release.py").exists())

    def test_link_directory_and_special_members_are_rejected(self):
        for kind in (tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.DIRTYPE, tarfile.FIFOTYPE, tarfile.CHRTYPE, tarfile.BLKTYPE):
            entries = copy.deepcopy(self.entries)
            member, _ = next(entry for entry in entries if entry[0].name == EXPECTED_FILES[0])
            member.type = kind
            member.linkname = "../../outside"
            member.size = 0
            with self.subTest(type=kind):
                self.reject(pack(entries))

    def test_gnu_pax_and_gzip_are_not_accepted_as_plain_ustar(self):
        self.reject(pack(self.entries, archive_format=tarfile.GNU_FORMAT))
        entries = copy.deepcopy(self.entries)
        entries[0][0].pax_headers = {"comment": "must not allow extension records"}
        self.reject(pack(entries, archive_format=tarfile.PAX_FORMAT))
        self.reject(gzip.compress(self.archive))

    def test_archive_member_and_aggregate_bounds_are_enforced(self):
        self.reject(b"x" * (self.bootstrap.MAX_ARCHIVE_BYTES + 1))
        contents = b"x" * (self.bootstrap.MAX_MEMBER_BYTES + 1)
        manifest = copy.deepcopy(self.manifest)
        manifest["files"][EXPECTED_FILES[0]].update(size=len(contents), sha256=digest(contents))
        archive, manifest_sha = self.replace_manifest(manifest)
        entries = [(member, contents if member.name == EXPECTED_FILES[0] else body)
                   for member, body in unpack(archive)]
        self.reject(pack(entries), manifest_sha256=manifest_sha)
        with mock.patch.object(self.bootstrap, "MAX_TOTAL_BYTES", 1):
            self.reject(self.archive)

    def test_empty_truncated_and_non_tar_inputs_are_rejected(self):
        for data in (b"", b"not an archive", self.archive[:512], self.archive[:len(self.archive) // 2], self.archive[:-1]):
            with self.subTest(bytes=len(data)):
                self.reject(data)

    def test_trailing_content_and_incomplete_end_marker_are_rejected(self):
        self.reject(self.archive + b"unreviewed trailing bytes".ljust(512, b"\x00"))
        physical_end = sum(512 + ((len(contents) + 511) // 512) * 512 for _, contents in self.entries)
        self.reject(self.archive[:physical_end + 512])

    def test_staging_is_private_readonly_and_never_uses_archive_ownership(self):
        state = self.directory / "state"
        state.mkdir(mode=0o700)
        stage_id = "1" * 32
        stage = self.bootstrap.stage_bundle(self.inspect(), state_root=state, stage_id=stage_id)
        self.assertEqual(stage, state / ".auto-maintenance-bundles" / (self.revision[:12] + "-" + stage_id))
        self.assertEqual(stat.S_IMODE(stage.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(stage.parent.stat().st_mode), 0o700)
        verified = self.inspect()
        for name in ("manifest.json", *EXPECTED_FILES):
            self.assertEqual((stage / name).read_bytes(), verified["files"][name])
            self.assertEqual(stat.S_IMODE((stage / name).stat().st_mode), 0o400)
            self.assertEqual((stage / name).stat().st_uid, os.geteuid())

    def test_existing_stage_and_attempt_sentinels_cannot_be_overwritten(self):
        state = self.directory / "state"
        state.mkdir(mode=0o700)
        bundle_parent = state / ".auto-maintenance-bundles"
        bundle_parent.mkdir(mode=0o700)
        stage_id = "2" * 32
        stage = bundle_parent / (self.revision[:12] + "-" + stage_id)
        stage.mkdir(mode=0o700)
        sentinel = stage / "attempt.json"
        sentinel.write_bytes(b"existing attempt result must survive")
        old_mode = sentinel.stat().st_mode
        with self.assertRaises(REJECTIONS):
            self.bootstrap.stage_bundle(self.inspect(), state_root=state, stage_id=stage_id)
        self.assertEqual(sentinel.read_bytes(), b"existing attempt result must survive")
        self.assertEqual(sentinel.stat().st_mode, old_mode)
        self.assertEqual(list(stage.iterdir()), [sentinel])

    def test_existing_stage_file_or_symlink_cannot_redirect_writes(self):
        state = self.directory / "state"
        state.mkdir(mode=0o700)
        parent = state / ".auto-maintenance-bundles"
        parent.mkdir(mode=0o700)
        stage_id = "3" * 32
        stage = parent / (self.revision[:12] + "-" + stage_id)
        stage.write_bytes(b"existing non-directory sentinel")
        with self.assertRaises(REJECTIONS):
            self.bootstrap.stage_bundle(self.inspect(), state_root=state, stage_id=stage_id)
        self.assertEqual(stage.read_bytes(), b"existing non-directory sentinel")
        stage.unlink()
        outside = self.directory / "outside"
        outside.mkdir()
        stage.symlink_to(outside, target_is_directory=True)
        with self.assertRaises(REJECTIONS):
            self.bootstrap.stage_bundle(self.inspect(), state_root=state, stage_id=stage_id)
        self.assertTrue(stage.is_symlink())
        self.assertEqual(list(outside.iterdir()), [])

    def test_stage_parent_symlinks_are_not_followed(self):
        outside = self.directory / "outside"
        outside.mkdir()
        for variant in ("state", "bundles"):
            with self.subTest(component=variant):
                state = self.directory / (variant + "-root")
                if variant == "state":
                    state.symlink_to(outside, target_is_directory=True)
                else:
                    state.mkdir(mode=0o700)
                    (state / ".auto-maintenance-bundles").symlink_to(outside, target_is_directory=True)
                with self.assertRaises(REJECTIONS):
                    self.bootstrap.stage_bundle(self.inspect(), state_root=state, stage_id="4" * 32)
                self.assertEqual(list(outside.iterdir()), [])

    def test_stage_identifiers_cannot_choose_external_paths(self):
        state = self.directory / "state"
        state.mkdir(mode=0o700)
        for stage_id in ("../outside", "/outside", "f" * 31, "f" * 33, "G" * 32, "A" * 32, "a" * 32 + "\n"):
            with self.subTest(stage_id=stage_id), self.assertRaises(REJECTIONS):
                self.bootstrap.stage_bundle(self.inspect(), state_root=state, stage_id=stage_id)
        self.assertFalse((self.directory / "outside").exists())

    def test_relative_or_empty_state_root_is_not_silently_absolutized(self):
        for state_root in (Path("relative-state"), Path("."), Path(""), ""):
            with self.subTest(state_root=str(state_root)), \
                 mock.patch.object(self.bootstrap, "protected_directory") as protected, \
                 self.assertRaises(REJECTIONS):
                self.bootstrap.stage_bundle(self.inspect(), state_root=state_root, stage_id="6" * 32)
            protected.assert_not_called()

    def test_new_stage_does_not_touch_existing_transaction_or_result_paths(self):
        state = self.directory / "state"
        state.mkdir(mode=0o700)
        sentinels = {}
        for name in ("auto-release.lock", "attempt.json", "result.json", "current-release-record"):
            path = state / name
            body = ("Existing unrelated transaction: " + name).encode()
            path.write_bytes(body)
            path.chmod(0o400)
            sentinels[path] = (body, path.stat().st_ino, path.stat().st_mode)
        self.bootstrap.stage_bundle(self.inspect(), state_root=state, stage_id="5" * 32)
        for path, (body, inode, mode) in sentinels.items():
            self.assertEqual((path.read_bytes(), path.stat().st_ino, path.stat().st_mode), (body, inode, mode))

    def test_cli_bad_archive_never_stages_or_dispatches_maintenance(self):
        compose = self.directory / "compose"
        compose.mkdir()
        args = [str(HERE / "bootstrap.py"), "--compose-dir", str(compose), "--host", "w2w.test",
                "--image", "fixture/w2w@sha256:" + "a" * 64, "--revision", self.revision,
                "--archive-sha256", digest(self.archive), "--manifest-sha256", digest(self.manifest_bytes)]
        invalid = [(member, body + b"tampered" if member.name == EXPECTED_FILES[0] else body)
                   for member, body in self.entries]
        invalid = pack(invalid)
        args[args.index("--archive-sha256") + 1] = digest(invalid)
        with mock.patch.object(sys, "argv", args), mock.patch.object(sys, "stdin", io.TextIOWrapper(io.BytesIO(invalid))), \
             mock.patch.dict(os.environ, {"W2W_RELEASE_APPROVED": "1", "W2W_RELEASE_STATE_DIR": str(self.directory / "private-state")}), \
             mock.patch.object(self.bootstrap, "stage_bundle") as stage, \
             mock.patch.object(self.bootstrap.os, "execve") as dispatch, \
             mock.patch.object(self.bootstrap.os, "dup2") as replace_stdin:
            try:
                self.bootstrap.main()
            except (*REJECTIONS, SystemExit):
                pass
            stage.assert_not_called()
            dispatch.assert_not_called()
            replace_stdin.assert_not_called()
        self.assertEqual(list(compose.iterdir()), [])

    def test_cli_reads_bounded_stdin_before_any_stage_or_dispatch(self):
        class BoundedInput(io.BytesIO):
            def read(self, size=-1):
                self.requested_size = size
                return super().read(size)

        stream = BoundedInput(b"x" * (self.bootstrap.MAX_ARCHIVE_BYTES + 1024))
        stdin = mock.Mock(buffer=stream)
        args = [str(HERE / "bootstrap.py"), "--compose-dir", str(self.directory), "--host", "w2w.test",
                "--image", "fixture/w2w@sha256:" + "a" * 64, "--revision", self.revision,
                "--archive-sha256", digest(self.archive), "--manifest-sha256", digest(self.manifest_bytes)]
        with mock.patch.object(sys, "argv", args), mock.patch.object(sys, "stdin", stdin), \
             mock.patch.dict(os.environ, {"W2W_RELEASE_APPROVED": "1"}), \
             mock.patch.object(self.bootstrap, "stage_bundle") as stage, \
             mock.patch.object(self.bootstrap.os, "execve") as dispatch, \
             mock.patch.object(self.bootstrap.os, "dup2") as replace_stdin:
            with self.assertRaises(REJECTIONS):
                self.bootstrap.main()
            stage.assert_not_called()
            dispatch.assert_not_called()
            replace_stdin.assert_not_called()
        self.assertEqual(stream.requested_size, self.bootstrap.MAX_ARCHIVE_BYTES + 1)
        self.assertEqual(stream.tell(), self.bootstrap.MAX_ARCHIVE_BYTES + 1)

    def test_valid_cli_dispatches_one_verified_stage_without_inherited_stdin(self):
        state = self.directory / "state"
        stage_path = self.directory / "verified-stage"
        args = [str(HERE / "bootstrap.py"), "--compose-dir", str(self.directory), "--host", "w2w.test",
                "--image", "fixture/w2w@sha256:" + "a" * 64, "--revision", self.revision,
                "--archive-sha256", digest(self.archive), "--manifest-sha256", digest(self.manifest_bytes)]
        events = []
        with mock.patch.object(sys, "argv", args), mock.patch.object(sys, "stdin", io.TextIOWrapper(io.BytesIO(self.archive))), \
             mock.patch.dict(os.environ, {"W2W_RELEASE_APPROVED": "1", "W2W_RELEASE_STATE_DIR": str(state)}), \
             mock.patch.object(self.bootstrap, "stage_bundle", return_value=stage_path) as stage, \
             mock.patch.object(self.bootstrap.os, "execve", side_effect=lambda *args: events.append("exec")) as dispatch, \
             mock.patch.object(self.bootstrap.os, "dup2", side_effect=lambda *args: events.append("stdin")) as replace_stdin:
            self.assertEqual(self.bootstrap.main(), 0)
            stage.assert_called_once()
            self.assertEqual(stage.call_args.args[0]["files"], self.inspect()["files"])
            self.assertEqual(stage.call_args.kwargs["state_root"], state)
            dispatch.assert_called_once()
            executable, command, environment = dispatch.call_args.args
            self.assertEqual(executable, sys.executable)
            self.assertEqual(command[:4], [sys.executable, str(stage_path / "deploy/maintenance/auto_release.py"),
                                           "--package-root", str(stage_path)])
            self.assertEqual(command[command.index("--revision") + 1], self.revision)
            self.assertEqual(environment["PYTHONDONTWRITEBYTECODE"], "1")
            self.assertEqual(environment["W2W_RELEASE_APPROVED"], "1")
            replace_stdin.assert_called_once()
            self.assertEqual(replace_stdin.call_args.args[1], 0)
            self.assertEqual(events, ["stdin", "exec"])

    def test_main_empty_environment_values_fall_back_like_release_controller(self):
        home = self.directory / "synthetic-home"
        explicit = self.directory / "explicit-state"
        xdg = self.directory / "xdg-state"
        variants = [
            ({"W2W_RELEASE_STATE_DIR": "", "XDG_STATE_HOME": ""}, home / ".local/state/w2w-releases"),
            ({"W2W_RELEASE_STATE_DIR": "", "XDG_STATE_HOME": str(xdg)}, xdg / "w2w-releases"),
            ({"W2W_RELEASE_STATE_DIR": str(explicit), "XDG_STATE_HOME": ""}, explicit),
        ]
        args = [str(HERE / "bootstrap.py"), "--compose-dir", str(self.directory), "--host", "w2w.test",
                "--image", "fixture/w2w@sha256:" + "a" * 64, "--revision", self.revision,
                "--archive-sha256", digest(self.archive), "--manifest-sha256", digest(self.manifest_bytes)]
        for environment, expected in variants:
            with self.subTest(environment=environment), mock.patch.object(sys, "argv", args), \
                 mock.patch.object(sys, "stdin", io.TextIOWrapper(io.BytesIO(self.archive))), \
                 mock.patch.dict(os.environ, {"W2W_RELEASE_APPROVED": "1", **environment}), \
                 mock.patch.object(self.bootstrap.Path, "home", return_value=home), \
                 mock.patch.object(self.bootstrap, "stage_bundle", return_value=self.directory / "verified-stage") as stage, \
                 mock.patch.object(self.bootstrap.os, "execve"), mock.patch.object(self.bootstrap.os, "dup2"):
                self.assertEqual(self.bootstrap.main(), 0)
                stage.assert_called_once()
                self.assertEqual(stage.call_args.kwargs["state_root"], expected)
        self.assertFalse(home.exists())
        self.assertFalse(xdg.exists())
        self.assertFalse(explicit.exists())

    def test_real_receiver_exec_preserves_pid_stdin_eof_and_exact_exit_status(self):
        repo, _ = make_repo(self.directory)
        dummy = '''import argparse,json,os,re,stat,sys
from pathlib import Path
parser=argparse.ArgumentParser()
for name in ('package-root','compose-dir','host','image','revision'):
    parser.add_argument('--'+name,required=True)
args=parser.parse_args()
stage=Path(args.package_root)
assert stage.is_absolute() and stage.parent.name=='.auto-maintenance-bundles'
assert Path(args.compose_dir).is_dir() and args.host=='w2w.test'
assert args.image=='fixture/w2w@sha256:'+'a'*64
assert re.fullmatch('[0-9a-f]{40}',args.revision)
assert os.environ.get('W2W_RELEASE_APPROVED')=='1'
assert os.environ.get('PYTHONDONTWRITEBYTECODE')=='1'
assert sys.stdin.buffer.read()==b''
assert stat.S_IMODE(stage.stat().st_mode)==0o700
manifest=json.loads((stage/'manifest.json').read_text())
assert manifest['revision']==args.revision
assert all(stat.S_IMODE((stage/name).stat().st_mode)==0o400 for name in ('manifest.json',*manifest['files']))
assert not list(stage.rglob('__pycache__'))
print(json.dumps({'pid':os.getpid(),'argv':sys.argv[1:],'stdin_eof':True,
                  'approved':True,'no_bytecode':True,'stage_files_readonly':True}),flush=True)
raise SystemExit(int(os.environ['W2W_BUNDLE_TEST_EXIT']))
'''
        (repo / "deploy/maintenance/auto_release.py").write_text(dummy)
        revision = commit(repo)
        bundle = self.directory / "real-receiver.tar"
        metadata = self.package.build_bundle(repo, revision, bundle)
        compose = self.directory / "local-compose"
        compose.mkdir()
        for expected_exit in (0, 17):
            with self.subTest(exit_status=expected_exit):
                state = self.directory / ("real-state-" + str(expected_exit))
                command = [sys.executable, "-B", str(HERE / "bootstrap.py"), "--compose-dir", str(compose),
                           "--host", "w2w.test", "--image", "fixture/w2w@sha256:" + "a" * 64,
                           "--revision", revision, "--archive-sha256", metadata["archive_sha256"],
                           "--manifest-sha256", metadata["manifest_sha256"]]
                # No production/authentication variables are passed to the fixture child.
                environment = {"PATH": os.environ.get("PATH", ""), "LANG": "C.UTF-8",
                               "W2W_RELEASE_APPROVED": "1", "PYTHONDONTWRITEBYTECODE": "1",
                               "W2W_RELEASE_STATE_DIR": str(state), "W2W_BUNDLE_TEST_EXIT": str(expected_exit)}
                with subprocess.Popen(command, env=environment, stdin=subprocess.PIPE,
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE) as child:
                    try:
                        output, error = child.communicate(bundle.read_bytes(), timeout=10)
                    except subprocess.TimeoutExpired:
                        child.kill()
                        child.communicate()
                        self.fail("Local receiver fixture timed out")
                    self.assertEqual(child.returncode, expected_exit, error.decode(errors="replace"))
                    result = json.loads(output)
                    self.assertEqual(result["pid"], child.pid, "Coordinator must replace, not fork from, the SSH receiver process")
                self.assertTrue(result["stdin_eof"])
                self.assertTrue(result["approved"])
                self.assertTrue(result["no_bytecode"])
                self.assertTrue(result["stage_files_readonly"])
                arguments = result["argv"]
                self.assertEqual(arguments[arguments.index("--revision") + 1], revision)
                self.assertEqual(arguments[arguments.index("--compose-dir") + 1], str(compose))
                stage = Path(arguments[arguments.index("--package-root") + 1])
                self.assertEqual(stage.parent, state / ".auto-maintenance-bundles")
                self.assertEqual(stat.S_IMODE((stage / "manifest.json").stat().st_mode), 0o400)


class RunnerTransportTests(unittest.TestCase):
    """Actual local Bash wrapper with fake SSH/curl; never connects anywhere."""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="w2w-bundle-transport-unit-")
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.repo, _ = make_repo(self.directory)
        for name in ("package.py", "bootstrap.py"):
            shutil.copyfile(HERE / name, self.repo / "deploy/maintenance" / name)
        self.revision = commit(self.repo)
        self.bin = self.directory / "bin"
        self.bin.mkdir()
        fake_ssh = self.bin / "ssh"
        fake_ssh.write_text("#!" + sys.executable + "\n" + '''
import hashlib,json,os,sys
payload=sys.stdin.buffer.read()
with open(os.environ['W2W_BUNDLE_TEST_SSH_LOG'],'a') as output:
    output.write(json.dumps({'arguments':sys.argv[1:],'archive_sha256':hashlib.sha256(payload).hexdigest(),'archive_bytes':len(payload)})+'\\n')
print('{"status":"released","public_health":"ok"}')
raise SystemExit(int(os.environ['W2W_BUNDLE_TEST_SSH_EXIT']))
''')
        fake_ssh.chmod(0o755)
        for name in ("curl", "docker"):
            path = self.bin / name
            path.write_text('#!/bin/sh\nprintf "unexpected endpoint/app command\\n" >> "$W2W_BUNDLE_TEST_FORBIDDEN_LOG"\nexit 99\n')
            path.chmod(0o755)
        self.ssh_log = self.directory / "ssh.jsonl"
        self.forbidden_log = self.directory / "forbidden.log"

    def run_transport(self, returncode, *, health_url="https://uncontacted.invalid/health", compose_dir=None):
        body = '''
source "$1" help >/dev/null
repo_dir=$2
revision=$3
deploy_target=fixture-user@uncontacted.invalid
DEPLOY_DIR=$4
RELEASE_HEALTH_URL=$5
RELEASE_IMAGE=fixture/w2w@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
run_bundle_remote
'''
        environment = dict(os.environ)
        environment.update(PATH=str(self.bin) + os.pathsep + environment.get("PATH", ""),
                           W2W_BUNDLE_TEST_SSH_LOG=str(self.ssh_log),
                           W2W_BUNDLE_TEST_FORBIDDEN_LOG=str(self.forbidden_log),
                           W2W_BUNDLE_TEST_SSH_EXIT=str(returncode))
        return subprocess.run(["bash", "-c", body, "fixture-transport", str(HERE.parents[1] / "deploy-auto.sh"),
                               str(self.repo), self.revision, str(compose_dir or self.directory / "compose path with spaces"), health_url],
                              env=environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=15)

    def assert_one_bounded_send(self):
        attempts = [json.loads(line) for line in self.ssh_log.read_text().splitlines()]
        self.assertEqual(len(attempts), 1, "An uncertain SSH outcome must never resend the release")
        self.assertIn("BatchMode=yes", attempts[0]["arguments"])
        self.assertIn("StrictHostKeyChecking=yes", attempts[0]["arguments"])
        self.assertIn("fixture-user@uncontacted.invalid", attempts[0]["arguments"])
        self.assertGreater(attempts[0]["archive_bytes"], 0)
        self.assertLessEqual(attempts[0]["archive_bytes"], 1_048_576)
        self.assertFalse(self.forbidden_log.exists(), "Transport must not independently curl, roll back or call Docker")
        return attempts[0]

    def test_ssh_255_with_success_stdout_stays_uncertain_without_resending(self):
        result = self.run_transport(255)
        self.assertEqual(result.returncode, 255)
        self.assertIn('"status":"released"', result.stdout)
        self.assertIn("without a confirmed result", result.stderr)
        self.assert_one_bounded_send()

    def test_nonzero_remote_status_is_not_promoted_to_success_or_retried(self):
        result = self.run_transport(17)
        self.assertEqual(result.returncode, 17)
        self.assert_one_bounded_send()

    def test_confirmed_zero_status_sends_only_once_without_second_public_commit_check(self):
        result = self.run_transport(0)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_one_bounded_send()

    def test_remote_quoting_preserves_metacharacters_as_one_literal_compose_path(self):
        compose = self.directory / "compose path's $(not-a-command); untouched"
        result = self.run_transport(0, compose_dir=compose)
        self.assertEqual(result.returncode, 0, result.stderr)
        attempt = self.assert_one_bounded_send()
        command = shlex.split(attempt["arguments"][-1])
        self.assertEqual(command[:5], ["env", "W2W_RELEASE_APPROVED=1", "PYTHONDONTWRITEBYTECODE=1", "python3", "-c"])
        self.assertEqual(command[command.index("--compose-dir") + 1], str(compose))
        self.assertEqual(command[command.index("--host") + 1], "uncontacted.invalid")
        self.assertEqual(command[command.index("--revision") + 1], self.revision)
        self.assertEqual(command[command.index("--archive-sha256") + 1], attempt["archive_sha256"])
        self.assertEqual(command[command.index("--image") + 1], "fixture/w2w@sha256:" + "a" * 64)
        self.assertFalse(compose.exists())

    def test_non_https_or_ambiguous_health_destinations_are_refused_before_ssh(self):
        urls = ["http://uncontacted.invalid/health", "https://uncontacted.invalid/other",
                "https://uncontacted.invalid/health?query=value", "https://uncontacted.invalid/health#fragment",
                "https://user:pass@uncontacted.invalid/health", "https://uncontacted.invalid:81/health",
                "https://uncontacted.invalid:bad/health", "https:///health", "https://[::1]/health"]
        for url in urls:
            with self.subTest(url=url):
                result = self.run_transport(0, health_url=url)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(self.ssh_log.exists())
                self.assertFalse(self.forbidden_log.exists())

    def test_committed_symlink_receiver_source_is_refused_before_ssh(self):
        source = self.repo / "deploy/maintenance/bootstrap.py"
        source.unlink()
        source.symlink_to("print('a link target must not become receiver code')")
        self.revision = commit(self.repo)
        result = self.run_transport(0)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.ssh_log.exists())
        self.assertFalse(self.forbidden_log.exists())

    def test_oversized_receiver_source_is_refused_before_ssh(self):
        (self.repo / "deploy/maintenance/bootstrap.py").write_bytes(b"x" * (524_288 + 1))
        self.revision = commit(self.repo)
        result = self.run_transport(0)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.ssh_log.exists())
        self.assertFalse(self.forbidden_log.exists())


if __name__ == "__main__":
    unittest.main()
