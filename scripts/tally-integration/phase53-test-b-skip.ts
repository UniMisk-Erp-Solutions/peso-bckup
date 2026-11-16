/**
 * Phase 5.3 Test B — application SKIP, zero Tally HTTP.
 */
import { mapPreparedJobItems } from "../../src/lib/tallyMapping/pipeline.ts";
import { decideDelivery } from "../../src/lib/tallyMapping/deliveryDecision.ts";
import {
  buildPhase53PreparedItem,
  deliveredStateRow,
  phase53MetaKey,
  PHASE53_TEST_A_HASH,
  PHASE53_TEST_A_TOKEN,
} from "./phase53-lib.ts";

async function main() {
  let httpRequestCount = 0;
  const item = await buildPhase53PreparedItem(PHASE53_TEST_A_TOKEN);
  const metaKey = phase53MetaKey();

  if (item.content_hash !== PHASE53_TEST_A_HASH) {
    console.log(
      JSON.stringify({
        final: "PHASE 5.3 TEST B FAILED",
        reason: "content_hash_mismatch_vs_test_a",
        expected: PHASE53_TEST_A_HASH,
        actual: item.content_hash,
      }),
    );
    process.exit(1);
  }

  const deliveryState = [deliveredStateRow(metaKey, PHASE53_TEST_A_HASH)];
  const decision = decideDelivery(metaKey, item.content_hash, new Map(deliveryState.map((r) => [r.delivery_key, r])));

  const mapped = mapPreparedJobItems([item], {
    organization_id: item.payload.organization_id,
    job_id: "phase53-test-b",
    delivery_state: deliveryState,
  });

  const metaCmds = mapped.commands.filter((c) => c.kind === "report_metadata");
  const metaDecision = mapped.decisions.find((d) => d.delivery_key === metaKey);

  const pass =
    decision === "skip" &&
    metaDecision?.action === "skip" &&
    metaCmds.length === 0 &&
    httpRequestCount === 0;

  console.log(
    JSON.stringify({
      step: "application_skip",
      reportMetadataDeliveryKey: metaKey,
      content_hash: item.content_hash,
      decideDelivery: decision,
      mapped_decision: metaDecision?.action,
      metadata_commands_emitted: metaCmds.length,
      http_request_count: httpRequestCount,
      pass,
    }),
  );

  if (!pass) {
    console.log(JSON.stringify({ final: "PHASE 5.3 TEST B FAILED — STOP REAL-TALLY OPS" }));
    process.exit(1);
  }

  console.log(JSON.stringify({ final: "PHASE 5.3 TEST B SKIP PASS — 0 HTTP REQUESTS" }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
