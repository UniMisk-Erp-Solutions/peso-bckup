#!/usr/bin/env python3
import json
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
SERVICE_ID = "evo3o0fdjaroxq7uohrm21cp"
EDGE = f"supabase-edge-functions-{SERVICE_ID}"
KONG = f"supabase-kong-{SERVICE_ID}"

cmds = [
    f"docker exec {EDGE} wc -c /home/deno/functions/bulk-users-import/index.ts",
    f"docker exec {EDGE} grep -E 'MIN_BULK_IMPORT_PASSWORD_LENGTH|sync_passwords_only|link_supervisors_only' /home/deno/functions/bulk-users-import/index.ts | head -10",
    # invoke function from inside kong network (no Cloudflare)
    f"""docker exec {KONG} sh -c 'wget -qO- --header="Content-Type: application/json" --post-data='{{"rows":[]}}' http://127.0.0.1:8000/functions/v1/bulk-users-import 2>&1 || curl -sS -X POST http://127.0.0.1:8000/functions/v1/bulk-users-import -H "Content-Type: application/json" -d '{{"rows":[]}}' 2>&1'""",
    f"docker ps --filter name={EDGE} --format '{{{{.Names}}}} status={{{{.Status}}}}'",
]

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(HOST, username=USER, password=PASSWORD, timeout=30)
for cmd in cmds:
    print("===", cmd[:120], "===")
    _, stdout, stderr = c.exec_command(cmd, timeout=120)
    print(stdout.read().decode())
    err = stderr.read().decode()
    if err.strip():
        print("ERR:", err)
c.close()
