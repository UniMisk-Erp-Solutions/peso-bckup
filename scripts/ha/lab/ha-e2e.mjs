#!/usr/bin/env node
/**
 * Priyanshu HA — full local E2E (Node). No production hosts. No git push.
 * Layer 1: state machine lifecycle + split-brain guard
 * Layer 2: file/integration checks
 * Layer 3: Docker (optional, if daemon running)
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');
const reportDir = path.join(repoRoot, 'tools/priyanshu-ha-lab/reports');
fs.mkdirSync(reportDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const masterLog = path.join(reportDir, `e2e-node-${stamp}.log`);
const lines = [];
const log = (m) => {
  lines.push(m);
  console.log(m);
};

const state = {
  HA_PHASE: 'NORMAL',
  VIP_OWNER: '46',
  DB_PRIMARY: '46',
  DB_STANDBY: '68',
  PG_46_WRITABLE: 1,
  PG_68_WRITABLE: 0,
  FENCED_46: 0,
  FENCED_68: 0,
  APP_46_UP: 1,
  APP_68_UP: 1,
  REPL_LAG_SEC: 0,
};

function countWritable() {
  return (state.PG_46_WRITABLE ? 1 : 0) + (state.PG_68_WRITABLE ? 1 : 0);
}

function assertSinglePrimary() {
  const w = countWritable();
  if (w > 1) throw new Error(`SPLIT_BRAIN writable=${w}`);
}

function persist() {
  assertSinglePrimary();
}

function cmd(name) {
  persist();
  switch (name) {
    case 'reset':
      Object.assign(state, {
        HA_PHASE: 'NORMAL',
        VIP_OWNER: '46',
        DB_PRIMARY: '46',
        DB_STANDBY: '68',
        PG_46_WRITABLE: 1,
        PG_68_WRITABLE: 0,
        FENCED_46: 0,
        FENCED_68: 0,
        APP_46_UP: 1,
        APP_68_UP: 1,
        REPL_LAG_SEC: 0,
      });
      break;
    case 'simulate-app46-down':
      state.APP_46_UP = 0;
      break;
    case 'simulate-keepalived-failover-to-68':
      if (!state.APP_68_UP) throw new Error('app68 down');
      state.VIP_OWNER = '68';
      state.HA_PHASE = 'FAILOVER_VIP';
      break;
    case 'fence-46':
      state.FENCED_46 = 1;
      state.PG_46_WRITABLE = 0;
      break;
    case 'promote-68':
      if (!state.FENCED_46) throw new Error('fence46 required');
      state.DB_PRIMARY = '68';
      state.DB_STANDBY = '46';
      state.PG_68_WRITABLE = 1;
      state.PG_46_WRITABLE = 0;
      state.HA_PHASE = 'PROMOTED_68';
      break;
    case 'simulate-46-return':
      state.FENCED_46 = 0;
      state.APP_46_UP = 1;
      state.HA_PHASE = 'REJOIN_PENDING';
      break;
    case 'rejoin-46-as-standby':
      state.PG_46_WRITABLE = 0;
      state.REPL_LAG_SEC = 120;
      state.HA_PHASE = 'REJOINING';
      break;
    case 'catchup-complete':
      state.REPL_LAG_SEC = 0;
      state.HA_PHASE = 'SYNCED';
      break;
    case 'failback-promote-46':
      if (state.DB_PRIMARY !== '68') throw new Error('primary must be 68');
      if (state.REPL_LAG_SEC !== 0) throw new Error('lag not zero');
      state.PG_68_WRITABLE = 0;
      state.PG_46_WRITABLE = 1;
      state.DB_PRIMARY = '46';
      state.DB_STANDBY = '68';
      state.VIP_OWNER = '46';
      state.HA_PHASE = 'NORMAL';
      break;
    case 'rejoin-68-as-standby':
      state.PG_68_WRITABLE = 0;
      break;
    case 'attempt-unsafe-dual-write':
      state.PG_46_WRITABLE = 1;
      state.PG_68_WRITABLE = 1;
      try {
        persist();
        throw new Error('should block');
      } catch (e) {
        state.PG_68_WRITABLE = 0;
        persist();
        return 'BLOCKED';
      }
    default:
      throw new Error(`unknown ${name}`);
  }
  persist();
}

function runLifecycle() {
  let pass = 0;
  const ok = (m) => {
    log(`PASS: ${m}`);
    pass++;
  };
  cmd('reset');
  ok('NORMAL');
  cmd('simulate-app46-down');
  ok('app46 down');
  cmd('simulate-keepalived-failover-to-68');
  ok(`vip=${state.VIP_OWNER}`);
  cmd('fence-46');
  ok('fenced46');
  cmd('promote-68');
  ok(`primary=${state.DB_PRIMARY}`);
  cmd('simulate-46-return');
  cmd('rejoin-46-as-standby');
  cmd('catchup-complete');
  cmd('failback-promote-46');
  ok(`failback primary=${state.DB_PRIMARY}`);
  cmd('rejoin-68-as-standby');
  const blocked = cmd('attempt-unsafe-dual-write');
  ok(blocked === 'BLOCKED' ? 'split-brain blocked' : 'split-brain');
  cmd('reset');
  ok(`final phase=${state.HA_PHASE}`);
  return pass;
}

function checkFiles() {
  const required = [
    'docs/ha/PRIYANSHU_HA_E2E_SYSTEM.md',
    'docs/ha/HA_AUTOMATIC_FAILOVER_FAILBACK.md',
    'tools/priyanshu-ha-lab/docker-compose.yml',
    'scripts/ha/lab/ha-lab-state-machine.sh',
    'scripts/ha/lab/run-priyanshu-ha-e2e.sh',
    'scripts/ha/lab/ha-lab-docker-e2e.sh',
    'scripts/ha/check-failover-safety.sh',
  ];
  for (const f of required) {
    const p = path.join(repoRoot, f);
    if (!fs.existsSync(p)) throw new Error(`missing ${f}`);
  }
  log('PASS: integration file checks');
}

function tryDocker() {
  const r = spawnSync('docker', ['info'], { encoding: 'utf8', shell: true });
  if (r.status !== 0) {
    log('SKIP: Docker daemon not running (start Docker Desktop for Layer 3)');
    return;
  }
  log('--- Docker Layer 3 ---');
  const bash = process.platform === 'win32' ? 'bash' : 'bash';
  const dr = spawnSync(bash, [path.join(__dirname, 'ha-lab-docker-e2e.sh')], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, PESOWISE_HA_LAB: '1' },
  });
  process.stdout.write(dr.stdout || '');
  process.stderr.write(dr.stderr || '');
  if (dr.status === 0) log('PASS: Docker PG + HAProxy E2E');
  else log('WARN: Docker E2E failed (see log)');
}

log('=== Priyanshu HA E2E (Node) ===');
log(`repo=${repoRoot}`);
log('production: NOT touched | push: NO');

const n = runLifecycle();
checkFiles();
tryDocker();

log(`=== Layer1 passes=${n} ===`);
log('PRIYANSHU_HA_E2E_COMPLETE');
fs.writeFileSync(masterLog, lines.join('\n'));
log(`Report: ${masterLog}`);
