#!/usr/bin/env node
/** DO NOT RUN — caused TallyPrime 7.1 c0000005 during doctor experiments. See TALLY-DOCTOR-C0000005-INCIDENT.md */
if (process.env.ALLOW_LIVE_TALLY !== "1") {
  console.error("BLOCKED: live Tally HTTP probes disabled. Set ALLOW_LIVE_TALLY=1 only after explicit approval.");
  process.exit(99);
}
process.exit(99);
