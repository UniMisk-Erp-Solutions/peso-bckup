#!/usr/bin/env python3
"""Deploy ALL supabase/functions to Coolify pesowise-main edge runtime only. No DB changes."""
from __future__ import annotations

import hashlib
import json
import os
import stat
import sys
import tempfile
from pathlib import Path

PKG = os.path.join(tempfile.gettempdir(), "paramiko_pkg")
if os.path.isdir(PKG):
    sys.path.insert(0, PKG)

import paramiko  # noqa: E402

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _ssh_credentials import load_ssh_credentials, cleanup_temp_files  # noqa: E402

HOST = "192.168.0.18"
USER = "webadmin"
_CREDS = load_ssh_credentials(HOST, USER)
PASSWORD = _CREDS.password
SERVICE_ID = os.environ.get("PESOWISE_SERVICE_ID", "evo3o0fdjaroxq7uohrm21cp")
EDGE_CONTAINER = f"supabase-edge-functions-{SERVICE_ID}"
KONG_CONTAINER = f"supabase-kong-{SERVICE_ID}"
REMOTE_FUNCTIONS_ROOT = "/home/deno/functions"
SKIP_DIRS = {"main", "hello"}  # Coolify samples — leave server copies untouched

REPO_ROOT = Path(__file__).resolve().parents[1]
LOCAL_FUNCTIONS = REPO_ROOT / "supabase" / "functions"

VERIFY_FUNCTIONS = [
    ("bulk-users-import", '{"rows":[]}', ["rows[] is required", "rows is required"]),
    ("finalize-expense-receipts", '{"rows":[]}', ["rows", "required", "unauthorized"]),
    ("compress-upload", "{}", ["file", "required", "unauthorized"]),
]


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def run(client: paramiko.SSHClient, cmd: str, timeout: int = 180) -> tuple[int, str, str]:
    print(f"$ {cmd}")
    _, stdout, stderr = client.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode("utf-8", errors="replace")
    err = stderr.read().decode("utf-8", errors="replace")
    code = stdout.channel.recv_exit_status()
    if out.strip():
        print(out.rstrip())
    if err.strip():
        print(err.rstrip(), file=sys.stderr)
    return code, out, err


def collect_deploy_files() -> list[tuple[str, Path]]:
    """Return (remote_relative_path, local_path) for every file to deploy."""
    items: list[tuple[str, Path]] = []
    if not LOCAL_FUNCTIONS.is_dir():
        raise FileNotFoundError(LOCAL_FUNCTIONS)

    for entry in sorted(LOCAL_FUNCTIONS.iterdir()):
        if entry.name in SKIP_DIRS:
            continue
        if entry.is_dir():
            for root, _, files in os.walk(entry):
                for name in files:
                    local = Path(root) / name
                    rel = local.relative_to(LOCAL_FUNCTIONS).as_posix()
                    items.append((rel, local))
        elif entry.is_file():
            items.append((entry.name, entry))
    return items


def main() -> int:
    deploy_files = collect_deploy_files()
    if not deploy_files:
        print("No function files found", file=sys.stderr)
        return 1

    local_hashes = {rel: sha256_file(path) for rel, path in deploy_files}

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    print(f"Connecting to {USER}@{HOST} (service {SERVICE_ID}) ...")
    client.connect(HOST, username=USER, password=PASSWORD, timeout=30)

    code, out, _ = run(client, f"docker ps --format '{{{{.Names}}}}' | grep -Fx '{EDGE_CONTAINER}'")
    if EDGE_CONTAINER not in out:
        print(f"Container {EDGE_CONTAINER} not running — aborting", file=sys.stderr)
        client.close()
        return 1

    # Confirm this is pesowise-main stack (label or compose project name)
    code, out, _ = run(
        client,
        f"docker inspect {EDGE_CONTAINER} --format '{{{{index .Config.Labels \"coolify.name\"}}}}'",
    )
    print(f"Coolify service label: {out.strip() or '(none)'}")

    sftp = client.open_sftp()
    tmp_prefix = f"/tmp/pesowise-ef-deploy-{SERVICE_ID}"

    print(f"\nDeploying {len(deploy_files)} files to {EDGE_CONTAINER}:{REMOTE_FUNCTIONS_ROOT} ...")
    for rel, local in deploy_files:
        remote_tmp = f"{tmp_prefix}/{rel}"
        remote_dir = os.path.dirname(remote_tmp)
        run(client, f"mkdir -p '{remote_dir}'")

        with sftp.file(remote_tmp, "wb") as rf:
            rf.write(local.read_bytes())
        if local.suffix in {".sh", ".ts"}:
            try:
                sftp.chmod(remote_tmp, stat.S_IRUSR | stat.S_IWUSR | stat.S_IXUSR | stat.S_IRGRP | stat.S_IROTH)
            except OSError:
                pass

        remote_dest = f"{REMOTE_FUNCTIONS_ROOT}/{rel}"
        remote_dest_dir = os.path.dirname(remote_dest)
        run(client, f"docker exec {EDGE_CONTAINER} mkdir -p '{remote_dest_dir}'")
        code, _, _ = run(client, f"docker cp '{remote_tmp}' {EDGE_CONTAINER}:'{remote_dest}'")
        if code != 0:
            print(f"FAILED: {rel}", file=sys.stderr)
            sftp.close()
            client.close()
            return code

        print(f"  OK {rel}")

    sftp.close()
    run(client, f"rm -rf '{tmp_prefix}'")

    print("\nVerifying SHA256 hashes inside container ...")
    mismatches: list[str] = []
    for rel, local in deploy_files:
        remote = f"{REMOTE_FUNCTIONS_ROOT}/{rel}"
        code, out, _ = run(client, f"docker exec {EDGE_CONTAINER} sha256sum '{remote}'")
        remote_hash = out.split()[0] if out.strip() else ""
        expected = local_hashes[rel]
        if remote_hash != expected:
            mismatches.append(f"{rel}: expected {expected[:12]}… got {remote_hash[:12]}…")
        else:
            print(f"  MATCH {rel}")

    if mismatches:
        print("HASH MISMATCHES:", file=sys.stderr)
        for m in mismatches:
            print(f"  {m}", file=sys.stderr)
        client.close()
        return 1

    print(f"\nRestarting {EDGE_CONTAINER} ...")
    code, _, _ = run(client, f"docker restart {EDGE_CONTAINER}", timeout=120)
    if code != 0:
        client.close()
        return code

    run(client, f"docker ps --filter name={EDGE_CONTAINER} --format 'status={{{{.Status}}}}'")

    print("\nHTTP smoke tests via Kong (internal) ...")
    verify_ok = 0
    for fn, body, needles in VERIFY_FUNCTIONS:
        cmd = (
            f"docker exec {KONG_CONTAINER} sh -c "
            f"\"curl -sS -o /tmp/ef-test.out -w '%{{http_code}}' "
            f"-X POST http://127.0.0.1:8000/functions/v1/{fn} "
            f"-H 'Content-Type: application/json' "
            f"-d '{body}' 2>/dev/null; echo; cat /tmp/ef-test.out 2>/dev/null | head -c 300\""
        )
        code, out, _ = run(client, cmd, timeout=60)
        http_code = out.splitlines()[0].strip() if out else ""
        resp_body = "\n".join(out.splitlines()[1:]) if out and "\n" in out else out
        hit = any(n.lower() in resp_body.lower() for n in needles)
        status = "OK" if hit or http_code in ("200", "400", "401", "403", "422") else "FAIL"
        if status == "OK":
            verify_ok += 1
        print(f"  {fn}: HTTP {http_code} [{status}] {resp_body[:120]!r}")

    # List deployed function folders
    run(client, f"docker exec {EDGE_CONTAINER} ls -1 {REMOTE_FUNCTIONS_ROOT}")

    client.close()

    print(f"\nDeployed {len(deploy_files)} files to {EDGE_CONTAINER} only.")
    print(f"Smoke tests passed: {verify_ok}/{len(VERIFY_FUNCTIONS)}")
    if mismatches:
        return 1
    return 0 if verify_ok >= 1 else 1


if __name__ == "__main__":
    raise SystemExit(main())
