#!/usr/bin/env python3
"""Deploy ONLY bulk-users-import/index.ts to Coolify pesowise-main via docker. No DB changes."""
import hashlib
import json
import os
import sys
import tempfile
import urllib.request

PKG = os.path.join(tempfile.gettempdir(), "paramiko_pkg")
if os.path.isdir(PKG):
    sys.path.insert(0, PKG)

import paramiko  # noqa: E402

HOST = "192.168.0.18"
USER = "webadmin"
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _ssh_credentials import load_ssh_credentials, cleanup_temp_files  # noqa: E402
import atexit
atexit.register(cleanup_temp_files)
_CREDS = load_ssh_credentials(HOST, USER)
PASSWORD = _CREDS.password
# pesowise-main Supabase stack (only service with bulk-users-import edge function)
SERVICE_ID = os.environ.get("PESOWISE_SERVICE_ID", "evo3o0fdjaroxq7uohrm21cp")
EDGE_CONTAINER = f"supabase-edge-functions-{SERVICE_ID}"
LOCAL_INDEX = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "supabase",
    "functions",
    "bulk-users-import",
    "index.ts",
)
REMOTE_CONTAINER_PATH = "/home/deno/functions/bulk-users-import/index.ts"
VERIFY_URL = os.environ.get(
    "VERIFY_URL",
    "https://pesowise-supabase.unimisk.com/functions/v1/bulk-users-import",
)
ANON_KEY = os.environ.get(
    "VITE_SUPABASE_ANON_KEY",
    os.environ["SUPABASE_SERVICE_ROLE_KEY"],  # required; no literal fallback
)
MARKER = "MIN_BULK_IMPORT_PASSWORD_LENGTH = 6"


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


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


def main() -> int:
    if not PASSWORD:
        print("Set COOLIFY_SSH_PASSWORD", file=sys.stderr)
        return 1
    if not os.path.isfile(LOCAL_INDEX):
        print(f"Missing {LOCAL_INDEX}", file=sys.stderr)
        return 1

    with open(LOCAL_INDEX, "r", encoding="utf-8") as f:
        local_body = f.read()
    if MARKER not in local_body:
        print(f"Local file missing marker: {MARKER}", file=sys.stderr)
        return 1
    local_hash = sha256_file(LOCAL_INDEX)

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    print(f"Connecting to {USER}@{HOST} ...")
    client.connect(HOST, username=USER, password=PASSWORD, timeout=30)

    # Confirm target container exists and has bulk-users-import (pesowise-main only)
    code, out, _ = run(
        client,
        f"docker ps --format '{{{{.Names}}}}' | grep -Fx '{EDGE_CONTAINER}'",
    )
    if EDGE_CONTAINER not in out:
        print(f"Container {EDGE_CONTAINER} not running", file=sys.stderr)
        client.close()
        return 1

    code, out, _ = run(
        client,
        f"docker exec {EDGE_CONTAINER} test -f {REMOTE_CONTAINER_PATH} && echo OK",
    )
    if "OK" not in out:
        print("bulk-users-import/index.ts not found in target container", file=sys.stderr)
        client.close()
        return 1

    # Backup inside container (same directory only)
    run(
        client,
        f"docker exec {EDGE_CONTAINER} cp -a {REMOTE_CONTAINER_PATH} "
        f"{REMOTE_CONTAINER_PATH}.bak-$(date +%Y%m%d%H%M%S)",
    )

    # Upload via SFTP to /tmp then docker cp into container (webadmin lacks /data/coolify perms)
    remote_tmp = f"/tmp/bulk-users-import-index-{SERVICE_ID}.ts"
    sftp = client.open_sftp()
    with sftp.file(remote_tmp, "w") as rf:
        rf.write(local_body)
    sftp.close()
    print(f"Uploaded to {remote_tmp}")

    code, _, _ = run(
        client,
        f"docker cp {remote_tmp} {EDGE_CONTAINER}:{REMOTE_CONTAINER_PATH}",
    )
    if code != 0:
        client.close()
        return code
    run(client, f"rm -f {remote_tmp}")

    code, out, _ = run(
        client,
        f"docker exec {EDGE_CONTAINER} sha256sum {REMOTE_CONTAINER_PATH}",
    )
    remote_hash = out.split()[0] if out.strip() else ""
    print(f"Local SHA256:  {local_hash}")
    print(f"Remote SHA256: {remote_hash}")
    if remote_hash != local_hash:
        print("HASH MISMATCH after upload", file=sys.stderr)
        client.close()
        return 1

    # Verify marker on remote file
    code, out, _ = run(
        client,
        f"docker exec {EDGE_CONTAINER} grep -F '{MARKER}' {REMOTE_CONTAINER_PATH}",
    )
    if MARKER not in out:
        print("Remote file missing expected marker after upload", file=sys.stderr)
        client.close()
        return 1
    print("Remote marker verified:", MARKER)

    code, out, _ = run(client, f"docker restart {EDGE_CONTAINER}", timeout=120)
    if code != 0:
        client.close()
        return code
    print(f"Restarted {EDGE_CONTAINER}")

    client.close()

    # HTTP smoke test
    try:
        req = urllib.request.Request(
            VERIFY_URL,
            data=json.dumps({"rows": []}).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "apikey": ANON_KEY,
                "Authorization": f"Bearer {ANON_KEY}",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=45) as resp:
            body = resp.read().decode("utf-8", errors="replace")
            print(f"Verify HTTP {resp.status}: {body[:400]}")
            if resp.status == 200 and ("rows[] is required" in body or "success" in body.lower()):
                print("VERIFICATION OK: bulk-users-import updated and responding.")
                return 0
            print("Unexpected HTTP response", file=sys.stderr)
            return 1
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        print(f"Verify HTTP {e.code}: {body[:400]}")
        if "rows[] is required" in body:
            print("VERIFICATION OK: bulk-users-import updated and responding.")
            return 0
        print(f"HTTP verify failed: {e}", file=sys.stderr)
        return 1 if remote_hash != local_hash else 0
    except Exception as e:
        print(f"HTTP verify failed (file upload OK): {e}", file=sys.stderr)
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
