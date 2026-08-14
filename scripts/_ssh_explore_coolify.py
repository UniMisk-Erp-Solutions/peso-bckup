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
    "find /data/coolify -type d -name bulk-users-import 2>/dev/null | head -30",
    "find /data/coolify -type d -name pesowise-main 2>/dev/null | head -30",
    "find /data/coolify -type d -name 'bulk-user*' 2>/dev/null | head -30",
    "docker ps --format '{{.Names}}' 2>/dev/null | grep -iE 'pesowise|supabase|edge' | head -30",
    "ls -la /data/coolify/services 2>/dev/null | head -40",
    "ls -la /data/coolify 2>/dev/null | head -20",
]

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(HOST, username=USER, password=PASSWORD, timeout=30)
for cmd in cmds:
    print("===", cmd, "===")
    _, stdout, stderr = c.exec_command(cmd, timeout=120)
    print(stdout.read().decode())
    err = stderr.read().decode()
    if err.strip():
        print("ERR:", err)
c.close()
