#!/usr/bin/env python3
import sys
import os
"""Verify pesowise-main edge functions via public Kong URL (no DB access)."""
import os, sys, tempfile, json
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
EDGE = f"supabase-edge-functions-{SID}"
BASE = "https://pesowise-supabase.unimisk.com/functions/v1"

FUNCTIONS = [
    "admin-create-user",
    "admin-reset-password",
    "admin-update-user-email",
    "bulk-categories-import",
    "bulk-field-definitions-import",
    "bulk-field-values-import",
    "bulk-users-import",
    "compress-upload",
    "finalize-expense-receipts",
    "resolve-employee-login",
    "send-account-created-email",
    "send-contact-lead-email",
]

py = f"""
import json, urllib.request, ssl
ctx = ssl.create_default_context()
base = {json.dumps(BASE)}
fns = {json.dumps(FUNCTIONS)}
body = json.dumps({{}}).encode()
for fn in fns:
    url = base + "/" + fn
    try:
        req = urllib.request.Request(url, data=body, headers={{"Content-Type": "application/json"}}, method="POST")
        with urllib.request.urlopen(req, timeout=20, context=ctx) as r:
            text = r.read().decode(errors="replace")[:200]
            print(f"OK {{fn}} HTTP {{r.status}}: {{text}}")
    except urllib.error.HTTPError as e:
        text = e.read().decode(errors="replace")[:200]
        # 4xx = function entrypoint exists (not 404/502 entrypoint missing)
        ok = e.code in (400, 401, 403, 405, 422, 500) and "entrypoint" not in text.lower()
        tag = "REACHABLE" if ok else "FAIL"
        print(f"{{tag}} {{fn}} HTTP {{e.code}}: {{text}}")
    except Exception as ex:
        print(f"FAIL {{fn}}: {{ex}}")
"""

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(HOST, username=USER, password=PW, timeout=30)

print("=== Container health + deployed dirs ===")
for cmd in [
    f"docker ps --filter name={EDGE} --format '{{{{.Status}}}}'",
    f"docker exec {EDGE} ls -1 /home/deno/functions | grep -vE '^(hello|main)$'",
]:
    _, o, _ = c.exec_command(cmd, timeout=30)
    print(o.read().decode().rstrip())

print("\n=== Version markers in container ===")
for cmd in [
    f"docker exec {EDGE} grep -h 'VERSION\\|MIN_BULK' /home/deno/functions/finalize-expense-receipts/index.ts /home/deno/functions/bulk-users-import/index.ts 2>/dev/null",
]:
    _, o, _ = c.exec_command(cmd, timeout=30)
    print(o.read().decode().rstrip())

print("\n=== HTTP reachability (public Kong) ===")
curl_loop = r"""for fn in admin-create-user admin-reset-password admin-update-user-email bulk-categories-import bulk-field-definitions-import bulk-field-values-import bulk-users-import compress-upload finalize-expense-receipts resolve-employee-login send-account-created-email send-contact-lead-email; do
  code=$(curl -sS -o /tmp/efresp.txt -w '%{http_code}' -X POST "https://pesowise-supabase.unimisk.com/functions/v1/$fn" -H 'Content-Type: application/json' -d '{}' 2>/dev/null || echo ERR)
  body=$(head -c 150 /tmp/efresp.txt 2>/dev/null | tr '\n' ' ')
  echo "$fn HTTP $code: $body"
done"""
_, o, e = c.exec_command(curl_loop, timeout=180)
print(o.read().decode())
err = e.read().decode()
if err.strip():
    print("ERR:", err)
c.close()
