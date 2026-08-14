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

tests = [
    ("bulk-users-import", '{"rows":[]}'),
    ("finalize-expense-receipts", "{}"),
    ("compress-upload", "{}"),
]

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(HOST, username=USER, password=PW, timeout=30)

for fn, body in tests:
    cmd = (
        f"docker exec {KONG} sh -c "
        f"\"curl -sS -o /tmp/ef-test.out -w '%{{http_code}}' "
        f"-X POST http://127.0.0.1:8000/functions/v1/{fn} "
        f"-H 'Content-Type: application/json' "
        f"-d '{body}' 2>/dev/null; echo; cat /tmp/ef-test.out 2>/dev/null | head -c 400\""
    )
    print(f"=== {fn} ===")
    _, o, e = c.exec_command(cmd, timeout=60)
    print(o.read().decode())
    err = e.read().decode()
    if err.strip():
        print("ERR:", err)

# Also check public URL if reachable from server
cmd2 = (
    "curl -sS -o /tmp/pub.out -w '%{http_code}' -X POST "
    "https://pesowise-supabase.unimisk.com/functions/v1/bulk-users-import "
    "-H 'Content-Type: application/json' -d '{\"rows\":[]}' 2>&1; echo; head -c 400 /tmp/pub.out"
)
print("=== public URL bulk-users-import ===")
_, o, e = c.exec_command(cmd2, timeout=60)
print(o.read().decode())

c.close()
