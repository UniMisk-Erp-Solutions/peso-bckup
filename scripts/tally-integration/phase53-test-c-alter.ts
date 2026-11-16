/**
 * Phase 5.3 Test C — production ALTER (one HTTP) after SKIP pass.
 */
import { parseTallyImportResponse } from "../../connector/tally/dist/responseParser.js";
import { mapPreparedJobItems } from "../../src/lib/tallyMapping/pipeline.ts";
import { serializeCommand } from "../../src/lib/tallyMapping/xml/serialize.ts";
import {
  buildPhase53PreparedItem,
  deliveredStateRow,
  phase53LedgerName,
  phase53MetaKey,
  PHASE53_MANUAL_ALTER_TOKEN,
  PHASE53_TEST_C_TOKEN,
  phase53TallyLedgerGuidForValidation,
  portListening,
  tallyPost,
  tallyProcessRunning,
  wrapEnvelopeForCompany,
} from "./phase53-lib.ts";

async function main() {
  let httpRequestCount = 0;
  const before = { tally_exe: tallyProcessRunning(), port_9000: portListening() };
  const metaKey = phase53MetaKey();
  const ledgerName = phase53LedgerName();

  const guid = phase53TallyLedgerGuidForValidation();
  if (!guid) {
    console.log(
      JSON.stringify({
        final: "TEST C FAILED",
        reason: "PHASE53_TALLY_LEDGER_GUID required for Alter identity (real Tally export GUID)",
      }),
    );
    process.exit(1);
  }

  const priorItem = await buildPhase53PreparedItem(PHASE53_MANUAL_ALTER_TOKEN);
  const item = await buildPhase53PreparedItem(PHASE53_TEST_C_TOKEN);
  if (item.content_hash === priorItem.content_hash) {
    console.log(JSON.stringify({ final: "TEST C FAILED", reason: "hash_unchanged" }));
    process.exit(1);
  }

  const deliveryState = [deliveredStateRow(metaKey, priorItem.content_hash)];
  const mapped = mapPreparedJobItems([item], {
    organization_id: item.payload.organization_id,
    job_id: "phase53-test-c",
    delivery_state: deliveryState,
  });

  const metaCmd = mapped.commands.find((c) => c.kind === "report_metadata");
  if (!metaCmd || metaCmd.kind !== "report_metadata") {
    console.log(JSON.stringify({ final: "TEST C FAILED", reason: "no_metadata_command" }));
    process.exit(1);
  }

  if (metaCmd.metadata.action !== "alter") {
    console.log(
      JSON.stringify({
        final: "TEST C FAILED",
        reason: "expected_alter",
        action: metaCmd.metadata.action,
      }),
    );
    process.exit(1);
  }

  if (metaCmd.metadata.ledger_name !== ledgerName) {
    console.log(JSON.stringify({ final: "TEST C FAILED", reason: "ledger_name_changed" }));
    process.exit(1);
  }

  const xmlFragment = serializeCommand(metaCmd);
  if (!/LEDGER ACTION="Alter"/.test(xmlFragment)) {
    console.log(JSON.stringify({ final: "TEST C FAILED", reason: "xml_not_alter" }));
    process.exit(1);
  }
  if (!xmlFragment.includes("<GUID>")) {
    console.log(JSON.stringify({ final: "TEST C FAILED", reason: "alter_xml_missing_guid" }));
    process.exit(1);
  }

  console.log(
    JSON.stringify({
      step: "production_alter_identity",
      metaKey,
      ledger_name: ledgerName,
      tally_master_guid: guid,
      prior_hash: priorItem.content_hash,
      new_content_hash: item.content_hash,
      marker: PHASE53_TEST_C_TOKEN,
      before,
    }),
  );

  if (!before.tally_exe || !before.port_9000) {
    console.log(JSON.stringify({ final: "TEST C FAILED", reason: "tally_not_ready" }));
    process.exit(1);
  }

  const envelope = wrapEnvelopeForCompany(xmlFragment);
  console.log("=== EXACT XML SENT (complete) ===");
  console.log(envelope);

  httpRequestCount += 1;
  const resp = await tallyPost(envelope);
  const after = { tally_exe: tallyProcessRunning(), port_9000: portListening() };
  const parsed = parseTallyImportResponse(resp.text);
  const errorsTag = Number(/<ERRORS[^>]*>(\d+)/i.exec(resp.text)?.[1] ?? -1);
  const exceptionsTag = Number(/<EXCEPTIONS[^>]*>(\d+)/i.exec(resp.text)?.[1] ?? -1);

  console.log(
    JSON.stringify({
      http_request_count: httpRequestCount,
      elapsed_ms: resp.elapsedMs,
      CREATED: parsed.created,
      ALTERED: parsed.altered,
      ERRORS: errorsTag,
      EXCEPTIONS: exceptionsTag,
      after,
    }),
  );
  console.log("=== EXACT TALLY RESPONSE (complete) ===");
  console.log(resp.text);

  const pass =
    parsed.created === 0 &&
    parsed.altered === 1 &&
    errorsTag === 0 &&
    exceptionsTag === 0 &&
    after.tally_exe &&
    after.port_9000;

  if (!pass) {
    console.log(JSON.stringify({ final: "PHASE 5.3 TEST C FAILED — STOPPED" }));
    process.exit(1);
  }

  console.log(
    JSON.stringify({
      final: "PHASE 5.3 TEST C ALTER PASS — MANUAL CHECKPOINT",
      ledger_name: ledgerName,
      verify: "Reopen same ledger; JSON remarks should show phase53-test-c-production-alter-pass",
    }),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
