#!/usr/bin/env node
/**
 * After Sync + TDL load: backfill indexed UDFs so Daily Project report rows appear.
 * Requires TallyPrime with company "PesoWise Integration Test" open (not just server idle).
 */
import { spawnSync } from "child_process";
import http from "node:http";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const company = "PesoWise Integration Test";

function post(xml, ms = 15_000) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: 9000,
        method: "POST",
        headers: { "Content-Type": "text/xml" },
        timeout: ms,
      },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve(d));
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.write(xml);
    req.end();
  });
}

const pingActive = await post(
  `<?xml version="1.0"?><ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>Company</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES></DESC></BODY></ENVELOPE>`,
  20_000,
).catch((e) => ({ error: e.message }));

const activeOk =
  String(pingActive).includes("PesoWise Integration Test") ||
  (String(pingActive).includes("COMPANY") && !String(pingActive).includes("TallyPrime Server is Running"));

if (!activeOk) {
  console.error(
    "Tally HTTP has no company loaded. Open PesoWise Integration Test in TallyPrime, F1 → TallyPrime Server ON (port 9000), then re-run.",
  );
  process.exit(2);
}

console.log(
  "TDL: load PesoWise-Bootstrap.tdl + PesoWise-Load.tdl from C:\\pesowise (NOT SafeMenu). Quit & restart Tally after F12 load.",
);

console.log("Tally HTTP OK — running DPR UDF backfill (set BACKFILL_LIMIT for batch size)...");
const r = spawnSync(process.execPath, ["scripts/tally-integration/backfill-dpr-flat-udfs.mjs"], {
  cwd: ROOT,
  stdio: "inherit",
  env: { ...process.env, BACKFILL_LIMIT: process.env.BACKFILL_LIMIT ?? "500" },
});
console.log("\nNext: copy tally-extension to C:\\pesowise, quit and restart TallyPrime (Ctrl+Alt+R = Repair Company, not TDL reload), open Gateway → PesoWise Reports (O) → Daily Project (D).");
process.exit(r.status ?? 1);
