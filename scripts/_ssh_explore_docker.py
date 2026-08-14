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

cmds = [
    "sudo ls -la /data/coolify 2>&1 | head -20",
    "docker ps --format '{{.Names}}' | grep edge-functions",
    "for n in $(docker ps --format '{{.Names}}' | grep edge-functions); do echo '---' $n; docker inspect $n --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{\"\\n\"}}{{end}}'; done",
    "for n in $(docker ps --format '{{.Names}}' | grep edge-functions); do echo '=== FUNC LIST' $n; docker exec $n ls -la /home/deno/functions 2>&1 | head -20; done",
    "for n in $(docker ps --format '{{.Names}}' | grep edge-functions); do echo '=== BULK' $n; docker exec $n ls -la /home/deno/functions/bulk-users-import 2>&1; docker exec $n head -5 /home/deno/functions/bulk-users-import/index.ts 2>&1; done",
    "docker ps --format 'table {{.Names}}\\t{{.Label \"com.docker.compose.project\"}}\\t{{.Label \"coolify.name\"}}\\t{{.Label \"coolify.serviceId\"}}' | grep -i supabase | head -40",
]

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(HOST, username=USER, password=PASSWORD, timeout=30)
for cmd in cmds:
    print("===", cmd[:100], "===")
    _, stdout, stderr = c.exec_command(cmd, timeout=180)
    out = stdout.read().decode()
    err = stderr.read().decode()
    print(out)
    if err.strip():
        print("ERR:", err)
c.close()
