/** Local only — no Tally HTTP. */
import { mapPreparedJobItems } from "../../src/lib/tallyMapping/pipeline.ts";
import { serializeCommand } from "../../src/lib/tallyMapping/xml/serialize.ts";
import {
  buildPhase53PreparedItem,
  deliveredStateRow,
  phase53MetaKey,
  PHASE53_TEST_A_HASH,
  PHASE53_TEST_C_TOKEN,
} from "./phase53-lib.ts";

const itemA = await buildPhase53PreparedItem("phase53-test-a-controlled-create");
const itemC = await buildPhase53PreparedItem(PHASE53_TEST_C_TOKEN);
const metaKey = phase53MetaKey();
const createMapped = mapPreparedJobItems([itemA], {
  organization_id: itemA.payload.organization_id,
  job_id: "cmp",
  delivery_state: [],
});
const alterMapped = mapPreparedJobItems([itemC], {
  organization_id: itemC.payload.organization_id,
  job_id: "cmp",
  delivery_state: [deliveredStateRow(metaKey, PHASE53_TEST_A_HASH)],
});
const createCmd = createMapped.commands.find((c) => c.kind === "report_metadata");
const alterCmd = alterMapped.commands.find((c) => c.kind === "report_metadata");
console.log("=== CREATE (serializeMetadataLedger, action=create) ===");
console.log(createCmd ? serializeCommand(createCmd) : "missing");
console.log("=== ALTER (serializeMetadataLedger, action=alter) ===");
console.log(alterCmd ? serializeCommand(alterCmd) : "missing");
