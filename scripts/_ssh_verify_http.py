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
SERVICE_ID = "evo3o0fdjaroxq7uohrm21cp"

# Find kong published port on host
cmds = [
    f"docker port supabase-kong-{SERVICE_ID} 8000/tcp 2>/dev/null | head -1",
    "curl -sS -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:8000/ 2>&1 || true",
    f"""python3 <<'PY'
import json, urllib.request, socket
# try common kong host ports
ports = []
import subprocess
out = subprocess.check_output(
    ["docker", "port", "supabase-kong-{SERVICE_ID}", "8000/tcp"],
    text=True, stderr=subprocess.DEVNULL,
).strip().splitlines()
for line in out:
    if ":" in line:
        ports.append(int(line.rsplit(":", 1)[-1]))
if not ports:
    ports = [8000]
payload = json.dumps({{"rows": []}}).encode()
for p in ports:
    url = f"http://127.0.0.1:{{p}}/functions/v1/bulk-users-import"
    try:
        req = urllib.request.Request(
            url, data=payload,
            headers={{"Content-Type": "application/json"}},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=15) as r:
            body = r.read().decode()
            print(f"PORT {{p}} HTTP {{r.status}}: {{body[:300]}}")
    except Exception as e:
        print(f"PORT {{p}} failed: {{e}}")
PY""",
]

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(HOST, username=USER, password=PASSWORD, timeout=30)
for cmd in cmds:
    print("=== CMD ===")
    _, stdout, stderr = c.exec_command(cmd, timeout=120)
    print(stdout.read().decode())
    err = stderr.read().decode()
    if err.strip():
        print("ERR:", err)
c.close()
