#!/usr/bin/env python3
"""Package only reviewed, immutable Git blobs for the server release controller."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
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


def git(repo, *args):
    return subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True).stdout


def build_bundle(repo: Path, revision: str, output: Path) -> dict:
    repo, output = Path(repo).resolve(), Path(output).absolute()
    require(re.fullmatch(r"[0-9a-f]{40}", revision), "Expected a full lowercase Git commit")
    require(git(repo, "rev-parse", "--show-toplevel").decode().strip() == str(repo), "Use the repository root")
    require(git(repo, "rev-parse", "HEAD").decode().strip() == revision, "HEAD differs from the verified revision")
    require(not git(repo, "status", "--porcelain=v1", "--untracked-files=normal"), "Use a clean, committed checkout")
    resolved_output = output.resolve()
    require(resolved_output != repo and repo not in resolved_output.parents, "Write the bundle outside the checkout")
    contents, entries = {}, {}
    for path in ALLOWED_FILES:
        entry = git(repo, "ls-tree", "-z", revision, "--", path).split(b"\0")
        require(len(entry) == 2 and entry[1] == b"", "Missing or ambiguous release source: " + path)
        header, name = entry[0].split(b"\t", 1)
        mode, kind, oid = header.split()
        require(name.decode() == path and kind == b"blob" and mode in (b"100644", b"100755"), "Release sources must be regular Git blobs")
        body = git(repo, "cat-file", "blob", oid.decode())
        require(len(body) <= MAX_MEMBER_BYTES, "Release source exceeds size limit")
        contents[path] = body
        entries[path] = {"sha256": hashlib.sha256(body).hexdigest(), "size": len(body), "mode": int(mode[-3:], 8)}
    manifest = json.dumps({"protocol": 1, "revision": revision, "files": entries}, sort_keys=True, separators=(",", ":")).encode()
    require(sum(map(len, contents.values())) + len(manifest) <= MAX_TOTAL_BYTES, "Bundle exceeds total size limit")
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w", format=tarfile.USTAR_FORMAT) as archive:
        for path, body in [("manifest.json", manifest), *contents.items()]:
            info = tarfile.TarInfo(path)
            info.size = len(body)
            info.mode = 0o600 if path == "manifest.json" else entries[path]["mode"]
            info.uid = info.gid = info.mtime = 0
            archive.addfile(info, io.BytesIO(body))
    payload = buffer.getvalue()
    require(len(payload) <= MAX_ARCHIVE_BYTES, "Archive exceeds size limit")
    # Recheck before writing: no mutable worktree bytes are ever packaged.
    require(git(repo, "rev-parse", "HEAD").decode().strip() == revision and not git(repo, "status", "--porcelain=v1", "--untracked-files=normal"), "Checkout changed while packaging")
    descriptor = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "wb") as stream:
        stream.write(payload)
        stream.flush()
        os.fsync(stream.fileno())
    return {"revision": revision, "archive_sha256": hashlib.sha256(payload).hexdigest(),
            "manifest_sha256": hashlib.sha256(manifest).hexdigest(), "archive_bytes": len(payload)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--revision", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(build_bundle(args.repo, args.revision, args.output), sort_keys=True))


if __name__ == "__main__":
    main()
