# Controlled E2E — live run log

## 2026-10-06 attempt (agent)

| Step | Result |
|------|--------|
| Local TCP `127.0.0.1:9000` | **PASS** |
| Edge boot probe (HTTPS, no Tally) | **PASS** |
| Paired agent config (smoke org) | **Present** |
| Migration + deploy + queue + sync + `run-once` | **NOT RUN** — no Coolify SSH credential in agent shell |

Backend is **self-hosted Supabase on Coolify** at `192.168.23.46` (service `kar0ro1k6jiyfxzzw7acnsza`, URL `pesowise-backup-supabase.unimisk.com`). Ops path: SSH → `docker exec` / `docker cp` on edge + db containers — not Supabase Cloud MCP.

**One-command resume** (same credential policy as `scripts/_ssh_credentials.py`):

```powershell
cd "c:\Users\admin\Desktop\priyanshu intern\test project\peso-bckup-priyanshu"
mkdir .local-sensitive-data -Force
Set-Content -NoNewline .local-sensitive-data\coolify_ssh_password.txt '<hasto password for .46>'
node scripts/tally-integration/execute-controlled-e2e-live.mjs
```

Script: `scripts/tally-integration/execute-controlled-e2e-live.mjs`  
Deploy only: `scripts/tally-integration/deploy-e2e-controlled-stack.mjs`

No Tally HTTP except a single Agent `run-once` POST. No `run`, no doctor.

## 2026-10-06 — Coolify deploy (user terminal)

| Item | Result |
|------|--------|
| Migration `20261007170000…` | **Applied** |
| Edge `run-tally-sync-delivery` + `tally-connector` | **Deployed + restarted** |
| POST checks `e2e_ack_hold`, bound claim, `manual_review` | **true** |

**Resume** (same PowerShell session, credential still loaded):

```powershell
$env:SKIP_DEPLOY = "1"
node scripts/tally-integration/execute-controlled-e2e-live.mjs
```
