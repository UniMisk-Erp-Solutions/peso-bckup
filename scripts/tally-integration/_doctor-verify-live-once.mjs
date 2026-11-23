#!/usr/bin/env node
/** DO NOT RUN — live verify disabled after c0000005. See docs/tally-integration/TALLY-DOCTOR-C0000005-INCIDENT.md */
if (process.env.ALLOW_LIVE_TALLY !== "1") {
  console.error("BLOCKED: live Tally verify disabled.");
  process.exit(99);
}
process.exit(99);
