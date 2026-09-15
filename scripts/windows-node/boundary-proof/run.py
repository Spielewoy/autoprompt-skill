#!/usr/bin/env python3
"""Exercise exact, hash-bound candidate C functions against mocked Windows APIs.

Requires a previously downloaded official source archive or a local source tree,
plus explicitly selected GCC/Clang. Does not download or modify the input source.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile

RELATIVE_SOURCE = Path("deps/uv/src/win/pipe.c")
FUNCTIONS = (
    "uv__pipe_is_appcontainer",
    "uv__unique_pipe_name",
    "uv__pipe_server",
    "uv__create_pipe_pair",
)


def need(condition, message):
    if not condition:
        raise ValueError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def file_digest(file):
    result = hashlib.sha256()
    with file.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def physical_file(file, max_size):
    need(file.is_absolute(), "Input path must be absolute")
    need(file.resolve(strict=True) == file, "Aliased source input refused")
    before = file.stat()
    need(file.is_file() and before.st_nlink == 1 and 0 < before.st_size <= max_size,
         "Input must be a bounded singly linked regular file")
    data = file.read_bytes()
    after = file.stat()
    need((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns,
          before.st_ctime_ns) ==
         (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns,
          after.st_ctime_ns), "Input changed while reading")
    need(len(data) == before.st_size, "Input length changed while reading")
    return data


def source_bytes(source, lock):
    source = Path(os.path.abspath(source))
    if source.is_dir():
        data = physical_file(source / RELATIVE_SOURCE, 4 * 1024 * 1024)
        provenance = {"kind": "tree", "path": str(source)}
    else:
        # Read once so archive verification and member extraction use the same bytes.
        data = physical_file(source, 128 * 1024 * 1024)
        need(digest(data) == lock["source"]["sha256"], "Source archive SHA256 mismatch")
        import io
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:*") as archive:
            wanted = "node-v" + lock["version"] + "/" + RELATIVE_SOURCE.as_posix()
            members = [member for member in archive.getmembers() if member.name == wanted]
            need(len(members) == 1, "Archive source member missing or duplicated")
            member = members[0]
            need(member.isfile() and 0 < member.size <= 4 * 1024 * 1024,
                 "Archive source member must be a bounded regular file")
            with archive.extractfile(member) as stream:
                data = stream.read()
            need(len(data) == member.size, "Archive member length mismatch")
        provenance = {"kind": "archive", "path": str(source),
                      "sha256": lock["source"]["sha256"]}
    need(digest(data) == lock["patch"]["originalFileSha256"],
         "Original pipe.c SHA256 mismatch")
    return data, provenance


def selected_tool(value):
    resolved = shutil.which(value)
    need(resolved is not None, "Selected tool not found: " + value)
    tool = Path(resolved).resolve(strict=True)
    need(tool.is_file(), "Selected tool must be an executable file")
    return str(tool)


def function(text, name):
    start = "static int " + name + "("
    need(text.count(start) == 1, "Function absent or duplicated: " + name)
    tail = text.split(start, 1)[1]
    need("\n}\n" in tail, "Function terminator absent: " + name)
    return start + tail.split("\n}\n", 1)[0] + "\n}\n"


def execute(command, cwd, environment, timeout):
    result = subprocess.run(command, cwd=cwd, env=environment, stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            text=True, timeout=timeout, check=False)
    need(result.returncode == 0,
         "Command failed (" + str(result.returncode) + "): " + command[0] +
         "\n" + result.stdout[-8192:] + result.stderr[-8192:])
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, help="Verified local source tree or official archive")
    parser.add_argument("--cc", required=True, help="Explicit GCC or Clang executable")
    parser.add_argument("--git", default="git", help="Git executable for exact patch application")
    args = parser.parse_args()
    here = Path(__file__).resolve().parent
    inputs = here.parent
    lock_bytes = (inputs / "build-lock.json").read_bytes()
    lock = json.loads(lock_bytes)
    need(lock["schema"] == 1 and lock["version"] == "24.20.0", "Unsupported source lock")
    patch = (inputs / "libuv-appcontainer-pipes.patch").read_bytes()
    need(digest(patch) == lock["patch"]["sha256"], "Candidate patch SHA256 mismatch")
    original, provenance = source_bytes(args.source, lock)
    cc, git = selected_tool(args.cc), selected_tool(args.git)
    compiler_hash = file_digest(Path(cc))
    # Drop compiler/include injection and user Git configuration. No source/build
    # scripts execute: Git applies one bound patch and the compiler consumes C.
    environment = {key: value for key, value in os.environ.items()
                   if key.upper() not in {
                       "CPATH", "C_INCLUDE_PATH", "CPLUS_INCLUDE_PATH", "OBJC_INCLUDE_PATH",
                       "LIBRARY_PATH", "GCC_EXEC_PREFIX", "COMPILER_PATH",
                       "CFLAGS", "CPPFLAGS", "LDFLAGS", "SDKROOT",
                   } and not key.upper().startswith("GIT_")}
    environment.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull)
    with tempfile.TemporaryDirectory(prefix="node-pipe-boundary-") as temporary:
        root = Path(temporary)
        source = root / RELATIVE_SOURCE
        source.parent.mkdir(parents=True)
        source.write_bytes(original)
        candidate_patch = root / "candidate.patch"
        candidate_patch.write_bytes(patch)
        execute([git, "apply", "--check", "--whitespace=error", str(candidate_patch)],
                root, environment, 20)
        execute([git, "apply", "--whitespace=error", str(candidate_patch)],
                root, environment, 20)
        candidate = source.read_bytes()
        need(digest(candidate) == lock["patch"]["patchedFileSha256"],
             "Patched pipe.c SHA256 mismatch")
        text = candidate.decode("utf-8")
        parts = [function(text, name) for name in FUNCTIONS]
        need(parts[-1] == function(original.decode("utf-8"), FUNCTIONS[-1]),
             "Client creation body must remain byte-for-byte unchanged")
        prefix = (here / "prefix.c").read_text(encoding="utf-8")
        suffix = (here / "suffix.c").read_text(encoding="utf-8")
        body = "\n".join(parts)
        proof = root / "boundary-proof.c"
        proof.write_text(prefix + body + suffix, encoding="utf-8", newline="\n")
        executable = root / ("boundary-proof.exe" if os.name == "nt" else "boundary-proof")
        command = [cc, "-std=c11", "-Wall", "-Wextra", "-Werror", "-O2",
                   str(proof), "-o", str(executable)]
        execute(command, root, environment, 60)
        result = execute([str(executable)], root, environment, 10)
        need(not result.stderr, "Unexpected boundary executable stderr")
        observed = json.loads(result.stdout)
        need(observed == {"boundaryCases": 26, "nativeWindows": False},
             "Boundary case count or native-claim mismatch")
        compiler = execute([cc, "--version"], root, environment, 10).stdout.splitlines()[0]
        need(file_digest(Path(cc)) == compiler_hash, "Selected compiler changed")
        print(json.dumps({
            **observed, "source": provenance, "lockSha256": digest(lock_bytes),
            "patchSha256": digest(patch), "candidateSourceSha256": digest(candidate),
            "extractedFunctionsSha256": digest(body.encode("utf-8")),
            "prefixSha256": digest(prefix.encode("utf-8")),
            "suffixSha256": digest(suffix.encode("utf-8")),
            "compiler": compiler, "compilerPath": cc, "compilerSha256": compiler_hash,
            "compileArguments": command[1:-3] + ["<temporary-source>", "-o", "<temporary-executable>"],
        }, indent=2))


if __name__ == "__main__":
    main()
