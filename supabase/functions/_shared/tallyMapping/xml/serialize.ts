import { stableStringify } from "../../tallySync/contentHash.ts";
import { PESOWISE_METADATA_GROUP_NAME, isTallyMasterGuid } from "../identities.ts";
import type { ReportMetadataRecord, TallyCommand, TallyMasterRef, TallyVoucherModel } from "../types.ts";
import { deliveryUpdatesFromCommands } from "../deliveryUpdates.ts";
import { escapeXmlAttr, escapeXmlText } from "./escape.ts";

function tallyMasterAction(action: "create" | "alter"): string {
  return action === "alter" ? "Alter" : "Create";
}

function serializeMaster(master: TallyMasterRef, action: "create" | "alter"): string {
  const tallyAction = tallyMasterAction(action);
  if (master.kind === "voucher_type") {
    const name = escapeXmlText(master.display_name);
    const parent = master.parent_group ? `<PARENT>${escapeXmlText(master.parent_group)}</PARENT>` : "";
    return `<TALLYMESSAGE>
  <VOUCHERTYPE ACTION="${tallyAction}">
    <NAME>${name}</NAME>
    ${parent}
    <NUMBERINGMETHOD>Manual</NUMBERINGMETHOD>
  </VOUCHERTYPE>
</TALLYMESSAGE>`;
  }
  if (master.kind === "group") {
    const name = escapeXmlText(master.display_name);
    const parent = master.parent_group ? `<PARENT>${escapeXmlText(master.parent_group)}</PARENT>` : "";
    return `<TALLYMESSAGE>
  <GROUP ACTION="${tallyAction}">
    <NAME.LIST><NAME>${name}</NAME></NAME.LIST>
    ${parent}
  </GROUP>
</TALLYMESSAGE>`;
  }

  const tag = master.kind === "cost_centre" ? "COSTCENTRE" : "LEDGER";
  const name = escapeXmlText(master.display_name);
  const parent = master.parent_group ? `<PARENT>${escapeXmlText(master.parent_group)}</PARENT>` : "";
  // No UDF on PW-Emp / PW-Cat — Bootstrap TDL must be loaded for PESOWISE_STABLE_KEY; names are deterministic.
  return `<TALLYMESSAGE>
  <${tag} ACTION="${tallyAction}">
    <NAME.LIST><NAME>${name}</NAME></NAME.LIST>
    ${parent}
    <LANGUAGENAME.LIST><NAME.LIST TYPE="String"><NAME>${name}</NAME></NAME.LIST></LANGUAGENAME.LIST>
  </${tag}>
</TALLYMESSAGE>`;
}

function serializeVoucher(v: TallyVoucherModel): string {
  const lines = v.entries
    .map(
      (e) => `<ALLLEDGERENTRIES.LIST>
      <LEDGERNAME>${escapeXmlText(e.ledger_key)}</LEDGERNAME>
      <ISDEEMEDPOSITIVE>${e.is_debit ? "Yes" : "No"}</ISDEEMEDPOSITIVE>
      <AMOUNT>${e.is_debit ? -Math.abs(e.amount) : Math.abs(e.amount)}</AMOUNT>
    </ALLLEDGERENTRIES.LIST>`,
    )
    .join("\n");
  const pesoId = v.peso_expense_id
    ? `<UDF:PESO_EXPENSE_ID TYPE="String">${escapeXmlText(v.peso_expense_id)}</UDF:PESO_EXPENSE_ID>`
    : v.peso_event_id
      ? `<UDF:PESO_EVENT_ID TYPE="String">${escapeXmlText(v.peso_event_id)}</UDF:PESO_EVENT_ID>`
      : "";
  return `<TALLYMESSAGE xmlns:UDF="TallyUDF">
  <VOUCHER ACTION="${v.action === "alter" ? "Alter" : "Create"}" VCHTYPE="${escapeXmlAttr(v.voucher_type)}">
    <DATE>${escapeXmlText(v.date.replace(/-/g, ""))}</DATE>
    <NARRATION>${escapeXmlText(v.narration)}</NARRATION>
    <VOUCHERNUMBER>${escapeXmlText(v.voucher_number ?? v.accounting_key.slice(-12))}</VOUCHERNUMBER>
    <UDF:PESOWISE_ACCOUNTING_KEY TYPE="String">${escapeXmlText(v.accounting_key)}</UDF:PESOWISE_ACCOUNTING_KEY>
    ${pesoId}
    ${lines}
  </VOUCHER>
</TALLYMESSAGE>`;
}

function serializePlainStringUdf(name: string, value: string): string {
  return `<UDF:${name} TYPE="String">${escapeXmlText(value)}</UDF:${name}>`;
}

/** Real Tally 7.1 validated metadata ledger import shape (minimum safe subset). */
function serializeMetadataLedger(record: ReportMetadataRecord): string {
  const json = stableStringify(record.payload);
  const name = escapeXmlText(record.ledger_name);
  const tallyAction = tallyMasterAction(record.action);
  // TallyPrime 7.1: Alter with PARENT / stable-key UDF can raise EXCEPTIONS=1 (Create accepts full shape).
  const parentBlock =
    record.action === "create"
      ? `<PARENT>${escapeXmlText(PESOWISE_METADATA_GROUP_NAME)}</PARENT>\n    `
      : "";
  const stableKeyBlock =
    record.action === "create"
      ? `<UDF:PESOWISE_STABLE_KEY TYPE="String">${escapeXmlText(record.metadata_key)}</UDF:PESOWISE_STABLE_KEY>\n    `
      : "";
  const guid =
    record.action === "alter" && record.tally_master_guid && isTallyMasterGuid(record.tally_master_guid)
      ? record.tally_master_guid
      : null;
  const identityBlock = guid
    ? `<GUID>${escapeXmlText(guid)}</GUID>\n    `
    : `<NAME.LIST><NAME>${name}</NAME></NAME.LIST>\n    `;
  const displayUdfBlock =
    record.display_udfs?.length
      ? record.display_udfs.map((u) => serializePlainStringUdf(u.name, u.value)).join("\n    ") + "\n    "
      : "";
  const metadataJsonBlock =
    record.action === "create"
      ? serializePlainStringUdf("PESOWISE_METADATA_JSON", json) + "\n    "
      : serializePlainStringUdf("PESOWISE_METADATA_JSON", json) + "\n    ";
  return `<TALLYMESSAGE xmlns:UDF="TallyUDF">
  <LEDGER ACTION="${tallyAction}">
    ${identityBlock}${parentBlock}${stableKeyBlock}${displayUdfBlock}${metadataJsonBlock}
  </LEDGER>
</TALLYMESSAGE>`;
}

export function serializeCommand(cmd: TallyCommand): string {
  switch (cmd.kind) {
    case "master":
      return serializeMaster(cmd.master, cmd.action);
    case "voucher":
      return serializeVoucher(cmd.voucher);
    case "report_metadata":
      return serializeMetadataLedger(cmd.metadata);
    default:
      return "";
  }
}

export function wrapEnvelope(innerMessages: string[]): string {
  const body = innerMessages.join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Import Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>All Masters</REPORTNAME>
        <STATICVARIABLES>
          <SVCURRENTCOMPANY><!-- configured at connector time --></SVCURRENTCOMPANY>
        </STATICVARIABLES>
      </REQUESTDESC>
      <REQUESTDATA>
${body}
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;
}

/** Sort commands for deterministic XML output. */
export function sortCommands(commands: TallyCommand[]): TallyCommand[] {
  const rank = (c: TallyCommand) => {
    if (c.kind === "master") {
      if (c.master.kind === "group") return `0:000000:${c.master.stable_key}`;
      return `0:${c.master.stable_key}`;
    }
    if (c.kind === "voucher") return `1:${c.voucher.accounting_key}`;
    return `2:${c.metadata.metadata_key}`;
  };
  return [...commands].sort((a, b) => rank(a).localeCompare(rank(b)));
}

export type XmlBatchWithUpdates = {
  batch_index: number;
  message_count: number;
  xml: string;
  delivery_updates: ReturnType<typeof deliveryUpdatesFromCommands>;
};

export function batchXmlFromCommands(
  commands: TallyCommand[],
  batchSize: number,
): { batch_index: number; message_count: number; xml: string }[] {
  return batchCommandsWithDeliveryUpdates(commands, batchSize).map(
    ({ batch_index, message_count, xml }) => ({ batch_index, message_count, xml }),
  );
}

export function batchCommandsWithDeliveryUpdates(
  commands: TallyCommand[],
  batchSize: number,
): XmlBatchWithUpdates[] {
  const sorted = sortCommands(commands);
  const batches: XmlBatchWithUpdates[] = [];
  for (let i = 0; i < sorted.length; i += batchSize) {
    const slice = sorted.slice(i, i + batchSize);
    const messages = slice.map(serializeCommand).filter(Boolean);
    batches.push({
      batch_index: batches.length,
      message_count: messages.length,
      xml: wrapEnvelope(messages),
      delivery_updates: deliveryUpdatesFromCommands(slice),
    });
  }
  if (sorted.length === 0) {
    batches.push({ batch_index: 0, message_count: 0, xml: wrapEnvelope([]), delivery_updates: [] });
  }
  return batches;
}
