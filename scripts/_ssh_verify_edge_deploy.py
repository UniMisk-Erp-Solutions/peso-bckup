#!/usr/bin/env python3
import sys
import os
import os, sys, tempfile
PKG = os.path.join(tempfile.gettempdir(), "paramiko_pkg")
if os.path.isdir(PKG):
    sys.path.insert(0, PKG)
import paramiko

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _ssh_credentials import load_ssh_credentials, cleanup_temp_files  # noqa: E402

HOST, USER = "192.168.0.18", "webadmin"
_CREDS = load_ssh_credentials(HOST, USER)
PW = _CREDS.password
SID = "evo3o0fdjaroxq7uohrm21cp"
EDGE, KONG = f"supabase-edge-functions-{SID}", f"supabase-kong-{SID}"

cmds = [
    f"docker ps --filter name={EDGE} --format '{{{{.Names}}}} status={{{{.Status}}}}'",
    f"docker exec {EDGE} ls -1 /home/deno/functions",
    f"docker exec {EDGE} grep -F 'receipt-finalizer-v4' /home/deno/functions/finalize-expense-receipts/index.ts",
    f"docker exec {EDGE} grep -F 'MIN_BULK_IMPORT_PASSWORD_LENGTH = 6' /home/deno/functions/bulk-users-import/index.ts",
    # HTTP via edge runtime directly (port 9000 inside container network)
    f"docker exec {EDGE} curl -sS -X POST -H 'Content-Type: application/json' -d '{{\"rows\":[]}}' http://127.0.0.1:9000/bulk-users-import 2>&1 | head -c 400",
    f"docker exec {EDGE} curl -sS -X POST -H 'Content-Type: application/json' -d '{{}}' http://127.0.0.1:9000/finalize-expense-receipts 2>&1 | head -c 400",
    # Kong path from host (curl on ubuntu host)
    "curl -sS -X POST -H 'Content-Type: application/json' -d '{\"rows\":[]}' http://127.0.0.1:54321/functions/v1/bulk-users-import 2>&1 | head -c 400",
]

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(HOST, username=USER, password=PW, timeout=30)
for cmd in cmds:
    print("===", cmd[:110], "===")
    _, o, e = c.exec_command(cmd, timeout=90)
    print(o.read().decode())
    err = e.read().decode()
    if err.strip():
        print("ERR:", err)
c.close()
