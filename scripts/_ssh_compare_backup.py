#!/usr/bin/env python3
import os
import sys
import tempfile

PKG = os.path.join(tempfile.gettempdir(), "paramiko_pkg")
if os.path.isdir(PKG):
    sys.path.insert(0, PKG)

import paramiko

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _ssh_credentials import load_ssh_credentials, cleanup_temp_files  # noqa: E402

HOST = "192.168.0.18"
USER = "webadmin"
_CREDS = load_ssh_credentials(HOST, USER)
PASSWORD = _CREDS.password
EDGE = "supabase-edge-functions-evo3o0fdjaroxq7uohrm21cp"
PATH = "/home/deno/functions/bulk-users-import"

cmds = [
    f"docker exec {EDGE} ls -la {PATH}/",
    f"docker exec {EDGE} sha256sum {PATH}/index.ts {PATH}/index.ts.bak_pre_update 2>/dev/null || true",
    f"docker exec {EDGE} grep -c 'MIN_BULK_IMPORT_PASSWORD_LENGTH = 6' {PATH}/index.ts.bak_pre_update 2>/dev/null || echo 'old backup: marker absent'",
    f"docker exec {EDGE} grep 'MIN_BULK_IMPORT_PASSWORD_LENGTH' {PATH}/index.ts.bak_pre_update 2>/dev/null | head -3 || true",
    f"docker logs {EDGE} --tail 15 2>&1",
]

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(HOST, username=USER, password=PASSWORD, timeout=30)
for cmd in cmds:
    print("===", cmd[:100], "===")
    _, stdout, stderr = c.exec_command(cmd, timeout=60)
    print(stdout.read().decode())
    err = stderr.read().decode()
    if err.strip():
        print("ERR:", err)
c.close()
