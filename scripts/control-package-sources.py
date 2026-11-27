"""Stage tracked application files and independently inspect their Git blobs in an FC ZIP."""
import hashlib
import json
import re
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import zipfile

MANIFESTS = {"deploy/v2/package.json": "package.json", "deploy/v2/package-lock.json": "package-lock.json"}
SCOPES = ("src", "fixtures", *MANIFESTS)
SENSITIVE_COMPONENT = re.compile(r"^(?:\.env(?:\..*)?|.*\.(?:pem|key))$", re.IGNORECASE)


def require(condition, code):
    if not condition:
        raise ValueError(code)


def git_entries(root, *args):
    raw = subprocess.check_output(["git", "-C", str(root), *args, "--", *SCOPES])
    return [entry.decode("utf-8") for entry in raw.split(b"\0") if entry]


def stage_files(root, stage):
    # Use the checkout's current bytes so normal working-tree builds retain edits.
    names = git_entries(root, "ls-files", "-z", "--cached")
    require(MANIFESTS.keys() <= set(names) and len(names) == len(set(names)), "TRACKED_INPUTS_INCOMPLETE")
    for name in names:
        require(not any(SENSITIVE_COMPONENT.fullmatch(p) for p in name.split("/")), "SENSITIVE_PACKAGE_PATH")
        src = root / name
        require(src.resolve(strict=True) == src and src.is_file(), "TRACKED_INPUT_NOT_REGULAR")
        target = stage / MANIFESTS.get(name, name)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, target)


def inspect_archive(root, archive):
    # The independent checkout's commit is the authority, including when its files
    # or index have since been edited. Non-source assets have their own build steps.
    expected = {}
    for entry in git_entries(root, "ls-tree", "-rlz", "--full-tree", "HEAD"):
        header, name = entry.split("\t", 1)
        mode, kind, oid, size = header.split()
        require(mode in ("100644", "100755") and kind == "blob", "SOURCE_TREE_NOT_REGULAR")
        expected[MANIFESTS.get(name, name)] = (oid, int(size))
    require(set(MANIFESTS.values()) <= expected.keys(), "SOURCE_TREE_MISSING_MANIFEST")
    with zipfile.ZipFile(archive) as package:
        seen = set()
        for info in package.infolist():
            name = info.orig_filename
            require(name not in seen and name == info.filename and
                    not any(ord(c) < 32 or c == "\\" for c in name) and
                    all(part not in ("", ".", "..") for part in name.split("/")) and
                    not stat.S_ISLNK(info.external_attr >> 16), "UNSAFE_OR_DUPLICATE_PATH")
            require(not any(SENSITIVE_COMPONENT.fullmatch(p) for p in name.split("/")), "SENSITIVE_PACKAGE_PATH")
            seen.add(name)
            if name not in expected:
                require(name == "runtime/node" or name.startswith(("web-dist/", "node_modules/")), "UNEXPECTED_PACKAGE_PATH")
                continue
            oid, size = expected[name]
            require(info.file_size == size, "SOURCE_MISMATCH")
            digest = hashlib.sha1(f"blob {size}\0".encode("ascii"))
            with package.open(info) as stream:
                for chunk in iter(lambda: stream.read(65536), b""):
                    digest.update(chunk)
            require(digest.hexdigest() == oid, "SOURCE_MISMATCH")
        require(expected.keys() <= seen and {"runtime/node", "web-dist/index.html"} <= seen, "PACKAGE_PATH_MISSING")
    return sorted(expected)


if __name__ == "__main__":
    operation, root_arg, dest_arg = sys.argv[1:]
    root = Path(root_arg).resolve(strict=True)
    dest = Path(dest_arg)
    if operation == "stage":
        stage_files(root, dest)
    elif operation == "inspect":
        print(json.dumps(inspect_archive(root, dest)))
    else:
        raise ValueError("UNKNOWN_OPERATION")
