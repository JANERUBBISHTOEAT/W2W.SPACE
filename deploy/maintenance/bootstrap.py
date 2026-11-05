#!/usr/bin/env python3
"""Receive a bounded, pinned source bundle; never extract arbitrary archive paths."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import stat
import sys
import tarfile

ALLOWED_FILES = (
    "deploy/maintenance/auto_release.py",
    "deploy/maintenance/maintenance.py",
    "deploy/maintenance/index.html",
    "deploy/maintenance/nginx.conf",
    "deploy/maintenance/location-override.conf",
    "remix/update.sh",
)
MAX_ARCHIVE_BYTES = 1_048_576
MAX_MEMBER_BYTES = 524_288
MAX_TOTAL_BYTES = 1_048_576


def require(condition, message):
    if not condition:
        raise ValueError(message)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "Duplicate manifest key")
        result[key] = value
    return result


def inspect_bundle(data: bytes, *, revision: str, archive_sha256: str, manifest_sha256: str) -> dict:
    require(re.fullmatch(r"[0-9a-f]{40}", revision), "Invalid revision")
    for checksum in (archive_sha256, manifest_sha256):
        require(re.fullmatch(r"[0-9a-f]{64}", checksum), "Invalid pinned checksum")
    require(0 < len(data) <= MAX_ARCHIVE_BYTES and len(data) % 512 == 0, "Invalid archive size")
    require(hashlib.sha256(data).hexdigest() == archive_sha256, "Archive checksum mismatch")
    # Inspect every physical header. tarfile alone hides PAX/GNU extension records.
    offset, total, members = 0, 0, {}
    while offset + 512 <= len(data):
        header = data[offset:offset + 512]
        if header == bytes(512):
            require(len(data) - offset >= 1024 and not any(data[offset:]), "Invalid archive end or trailing content")
            break
        require(header[257:265] == b"ustar\x0000" and header[156:157] in (b"0", b"\0"), "Only regular USTAR files are supported")
        require(not any(header[157:257]) and not any(header[345:500]), "Archive links and path prefixes are forbidden")
        raw_name = header[:100]
        name_bytes, _, rest = raw_name.partition(b"\0")
        require(not any(rest), "Invalid file name padding")
        name = name_bytes.decode("ascii")
        require(name in ("manifest.json", *ALLOWED_FILES) and name not in members, "Unexpected or duplicate bundle member")
        info = tarfile.TarInfo.frombuf(header, "ascii", "strict")
        require(0 <= info.size <= MAX_MEMBER_BYTES, "Member exceeds size limit")
        require(info.mode in (0o600, 0o644, 0o755), "Unsupported source mode")
        start, end = offset + 512, offset + 512 + info.size
        padded_end = start + ((info.size + 511) // 512) * 512
        require(padded_end <= len(data) and not any(data[end:padded_end]), "Truncated member or invalid padding")
        total += info.size
        require(total <= MAX_TOTAL_BYTES, "Bundle exceeds total size limit")
        members[name] = (data[start:end], info.mode)
        offset = padded_end
    else:
        raise ValueError("Missing archive terminator")
    require(set(members) == {"manifest.json", *ALLOWED_FILES}, "Incomplete bundle")
    manifest_bytes = members["manifest.json"][0]
    require(hashlib.sha256(manifest_bytes).hexdigest() == manifest_sha256, "Pinned manifest checksum mismatch")
    manifest = json.loads(manifest_bytes, object_pairs_hook=unique_object)
    require(isinstance(manifest, dict) and set(manifest) == {"protocol", "revision", "files"}, "Invalid manifest shape")
    require(type(manifest["protocol"]) is int and manifest["protocol"] == 1 and manifest["revision"] == revision, "Manifest revision/protocol mismatch")
    require(isinstance(manifest["files"], dict) and set(manifest["files"]) == set(ALLOWED_FILES), "Manifest allowlist mismatch")
    require(json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode() == manifest_bytes, "Manifest must use canonical JSON")
    for name in ALLOWED_FILES:
        body, mode = members[name]
        entry = manifest["files"][name]
        require(isinstance(entry, dict) and set(entry) == {"size", "mode", "sha256"}, "Invalid manifest file entry")
        require(type(entry["size"]) is int and entry["size"] == len(body), "Manifest size mismatch")
        require(type(entry["mode"]) is int and entry["mode"] in (0o644, 0o755) and entry["mode"] == mode, "Manifest mode mismatch")
        require(entry["sha256"] == hashlib.sha256(body).hexdigest(), "Source checksum mismatch")
    return {"manifest": manifest, "files": {name: body for name, (body, _) in members.items()}}


def protected_directory(path: Path, *, create=False):
    require(path.is_absolute(), "State paths must be absolute")
    # No symlink component, including an existing parent of a newly created path.
    for component in (Path(path.anchor), *reversed(tuple(path.parents)[:-1]), path):
        if component.exists() or component.is_symlink():
            info = component.lstat()
            require(stat.S_ISDIR(info.st_mode), "State path contains a non-directory or symbolic link")
    if create:
        path.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = path.lstat()
    require(info.st_uid == os.getuid() and not (info.st_mode & 0o022), "State directory must be owned and not writable by others")


def stage_bundle(verified: dict, *, state_root: Path, stage_id: str | None = None) -> Path:
    state_root = Path(state_root)
    require(state_root.is_absolute(), "State paths must be absolute")
    protected_directory(state_root, create=True)
    parent = state_root / ".auto-maintenance-bundles"
    protected_directory(parent, create=True)
    stage_id = stage_id or secrets.token_hex(16)
    require(re.fullmatch(r"[0-9a-f]{32}", stage_id), "Invalid stage identifier")
    stage = parent / (verified["manifest"]["revision"][:12] + "-" + stage_id)
    stage.mkdir(mode=0o700)  # Exclusive: never reuse or overwrite a prior attempt.
    for name in ("deploy", "deploy/maintenance", "remix"):
        (stage / name).mkdir(mode=0o700)
    for name, body in verified["files"].items():
        require(name in ("manifest.json", *ALLOWED_FILES), "Unexpected staged file")
        descriptor = os.open(stage / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o400)
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(body)
            stream.flush()
            os.fsync(stream.fileno())
    descriptor = os.open(stage, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    return stage


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for argument in ("compose-dir", "host", "image", "revision", "archive-sha256", "manifest-sha256"):
        parser.add_argument("--" + argument, required=True)
    args = parser.parse_args()
    require(os.environ.get("W2W_RELEASE_APPROVED") == "1", "Release must be coordinated")
    verified = inspect_bundle(sys.stdin.buffer.read(MAX_ARCHIVE_BYTES + 1), revision=args.revision,
                              archive_sha256=args.archive_sha256, manifest_sha256=args.manifest_sha256)
    state_home = Path(os.environ.get("XDG_STATE_HOME") or str(Path.home() / ".local/state"))
    state_root = Path(os.environ.get("W2W_RELEASE_STATE_DIR") or str(state_home / "w2w-releases"))
    stage = stage_bundle(verified, state_root=state_root)
    command = [sys.executable, str(stage / "deploy/maintenance/auto_release.py"), "--package-root", str(stage)]
    for name in ("compose_dir", "host", "image", "revision"):
        command.extend(["--" + name.replace("_", "-"), getattr(args, name)])
    environment = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
    # Preserve the SSH process identity so signals reach the coordinator rather
    # than killing an intermediate receiver and leaving an orphaned release.
    with open(os.devnull, "rb") as empty_input:
        os.dup2(empty_input.fileno(), 0)
    os.execve(sys.executable, command, environment)
    return 0  # Only reachable when execve is mocked by the offline tests.


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, OSError, tarfile.TarError) as error:
        print("Source bundle rejected: " + str(error), file=sys.stderr)
        sys.exit(1)
