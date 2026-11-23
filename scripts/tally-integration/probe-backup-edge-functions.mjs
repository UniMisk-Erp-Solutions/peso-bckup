#!/usr/bin/env node
/** Non-mutating HTTPS probes for Tally edge functions (expect 401 without token). */
const BASE = (process.env.TALLY_VALIDATE_SUPABASE_URL ?? "https://pesowise-backup-supabase.unimisk.com").replace(
  /\/$/,
  "",
);

async function probe(name, url, init) {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15000) });
    const text = (await res.text()).slice(0, 200);
    return { function: name, status: res.status, reachable: true, body_preview: text };
  } catch (e) {
    return { function: name, reachable: false, error: e.message };
  }
}

async function main() {
  const delivery = await probe(
    "run-tally-sync-delivery",
    `${BASE}/functions/v1/run-tally-sync-delivery`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
  );
  const connector = await probe(
    "tally-connector",
    `${BASE}/functions/v1/tally-connector`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "heartbeat" }) },
  );
  console.log(JSON.stringify({ base: BASE, delivery, connector }, null, 2));
  const deliveryBootOk =
    delivery.reachable && delivery.status !== 500 && !/Worker|Module not found|boot error/i.test(delivery.body_preview ?? "");
  const connectorBootOk =
    connector.reachable && connector.status !== 500 && !/Worker|Module not found|boot error/i.test(connector.body_preview ?? "");
  const ok =
    deliveryBootOk &&
    connectorBootOk &&
    (delivery.status === 401 || delivery.status === 400 || delivery.status === 403) &&
    connector.status === 401;
  console.error(
    deliveryBootOk && connectorBootOk ? "BOOT_PROBE_PASS" : "BOOT_PROBE_FAIL",
  );
  process.exit(ok ? 0 : 1);
}

main();
