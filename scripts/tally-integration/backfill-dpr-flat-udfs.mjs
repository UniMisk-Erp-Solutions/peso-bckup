#!/usr/bin/env node
/**
 * Fill flat DPR UDFs on metadata ledgers from JSON (Alter). Names from DB delivery_state or Tally export.
 */
import http from "node:http";
import { sshPsqlJson } from "./_sshPsqlRemote.mjs";
import { requireCoolifySshPassword } from "./_coolifySshCredentials.mjs";

const company = "PesoWise Integration Test";
const ORG = "6709c1fe-e8c8-404d-bc68-d1edda923344";
const limit = Number(process.env.BACKFILL_LIMIT ?? "800");

const UDF_INDEX = {
  PESOWISE_REPORT_TYPE: "25002",
  PESOWISE_DPR_TRACK_DATE: "25010",
  PESOWISE_DPR_VOUCHER_NO: "25011",
  PESOWISE_DPR_PROJECT_ID: "25012",
  PESOWISE_DPR_PROJECT_NAME: "25013",
  PESOWISE_DPR_EMPLOYEE: "25014",
  PESOWISE_DPR_EMPLOYEE_CODE: "25015",
  PESOWISE_DPR_LOCATION: "25016",
  PESOWISE_DPR_REMARKS: "25017",
  PESOWISE_DPR_PETROL_COST: "25018",
  PESOWISE_DPR_MATERIAL_COST: "25019",
  PESOWISE_DPR_TRAVELLING_COST: "25020",
  PESOWISE_DPR_PHONE_EXP: "25021",
  PESOWISE_DPR_HOTEL_EXP: "25022",
  PESOWISE_DPR_TRANSPORT_EXP: "25023",
  PESOWISE_DPR_CONTRA_BILL: "25024",
  PESOWISE_DPR_OTHER_EXP: "25025",
  PESOWISE_DPR_PERCENT: "25026",
  PESOWISE_DPR_PRESENCE: "25027",
  PESOWISE_REPORT_FLAT_ROW: "25028",
  PESOWISE_META_JSON_PLAIN: "25029",
};

function pipeSafe(v) {
  return String(v ?? "")
    .replace(/\|/g, " ")
    .replace(/\r?\n/g, " ")
    .trim();
}

function buildFlatRow(meta) {
  const fields = meta.fields ?? {};
  const costs = fields.costs ?? {};
  const num = (k) => {
    const n = Number(costs[k]);
    return Number.isFinite(n) && n !== 0 ? String(n) : "";
  };
  const trackIso = String(fields.track_date ?? "").trim();
  const track = formatTrackDateForTally(trackIso);
  return [
    pipeSafe(track),
    pipeSafe(fields.voucher_no),
    pipeSafe(meta.project_id),
    pipeSafe(fields.project_name),
    pipeSafe(fields.employee_name),
    pipeSafe(fields.employee_code),
    pipeSafe(fields.location),
    pipeSafe(resolveRemarks(fields, fields)),
    pipeSafe(num("petrol_cost")),
    pipeSafe(num("material_cost")),
    pipeSafe(num("travelling_cost")),
    pipeSafe(num("phone_exp")),
    pipeSafe(num("hotel_exp")),
    pipeSafe(num("transport_exp")),
    pipeSafe(num("contra_bill")),
    pipeSafe(num("other_exp")),
    pipeSafe(payrollPercent(fields, fields)),
  ].join("|");
}

function formatTrackDateForTally(iso) {
  const raw = String(iso ?? "").trim();
  const d = raw.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return raw;
  const [y, m, day] = d.split("-");
  return `${day}-${m}-${y}`;
}

function payrollPercent(row, fields) {
  const direct = row.percent ?? fields.percent;
  if (direct != null && direct !== "") return String(direct);
  const n = Number(row.projects_in_employee_day ?? fields.projects_in_employee_day);
  if (!Number.isFinite(n) || n < 1) return "";
  return String(Math.round((100 / n) * 100) / 100);
}

function resolveRemarks(row, fields) {
  const direct = String(row.remarks ?? fields.remarks ?? "").trim();
  if (direct) return direct;
  const src = row.source_expenses ?? fields.source_expenses;
  if (!Array.isArray(src)) return "";
  return src
    .map((e) => String(e?.purpose ?? "").trim())
    .filter(Boolean)
    .join(", ");
}

function escapeXmlText(v) {
  return String(v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function postXml(xml, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: 9000,
        method: "POST",
        headers: { "Content-Type": "text/xml", "Content-Length": Buffer.byteLength(xml, "utf8") },
        timeout: timeoutMs,
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

function decodeXmlJson(raw) {
  if (!raw) return "";
  return raw
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

async function ledgerNamesFromDb() {
  const pass = requireCoolifySshPassword();
  const sql = `
SELECT jsonb_agg(tally_remote_id) AS names FROM (
  SELECT DISTINCT tally_remote_id
  FROM tally_delivery_state
  WHERE organization_id = '${ORG}'
    AND delivery_kind = 'report_metadata'
    AND delivery_key LIKE '%meta:daily_project_report%'
    AND tally_remote_id IS NOT NULL
    AND tally_remote_id LIKE 'PW-META%'
  ORDER BY tally_remote_id
  LIMIT ${limit}
) s;`;
  const row = await sshPsqlJson(sql, { password: pass });
  if (Array.isArray(row)) return row.filter(Boolean);
  return (row?.names ?? []).filter(Boolean);
}

async function exportLedger(name) {
  const activeXml = `<?xml version="1.0"?>
<ENVELOPE>
  <HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Object</TYPE><SUBTYPE>Ledger</SUBTYPE><ID TYPE="Name">${escapeXmlText(name)}</ID></HEADER>
  <BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES>
    <FETCHLIST><FETCH>PESOWISE_METADATA_JSON</FETCH></FETCHLIST>
  </DESC></BODY>
</ENVELOPE>`;
  let ex = await postXml(activeXml, 120_000);
  if (ex.includes("LEDGER") || ex.includes("PESOWISE_METADATA")) return ex;
  const namedXml = activeXml.replace(
    "<SVEXPORTFORMAT>",
    `<SVCURRENTCOMPANY>${escapeXmlText(company)}</SVCURRENTCOMPANY><SVEXPORTFORMAT>`,
  );
  ex = await postXml(namedXml, 120_000);
  return ex;
}

function parseMetaJson(exportXml) {
  const jsonM =
    exportXml.match(/<PESOWISE_METADATA_JSON[^>]*>([\s\S]*?)<\/PESOWISE_METADATA_JSON>/i) ??
    exportXml.match(/<UDF:PESOWISE_METADATA_JSON[^>]*>([\s\S]*?)<\/UDF:PESOWISE_METADATA_JSON>/i);
  if (!jsonM) return null;
  try {
    return JSON.parse(decodeXmlJson(jsonM[1].trim()));
  } catch {
    return null;
  }
}

function buildAlter(name, meta) {
  const fields = meta.fields ?? {};
  const costs = fields.costs ?? {};
  const num = (k) => {
    const n = Number(costs[k]);
    return Number.isFinite(n) && n !== 0 ? String(n) : "";
  };
  const flatRow = buildFlatRow(meta);
  const jsonPlain = JSON.stringify(meta);
  const udfs = {
    PESOWISE_REPORT_TYPE: "daily_project_report",
    PESOWISE_REPORT_FLAT_ROW: flatRow,
    PESOWISE_META_JSON_PLAIN: jsonPlain,
    PESOWISE_DPR_TRACK_DATE: formatTrackDateForTally(fields.track_date),
    PESOWISE_DPR_VOUCHER_NO: String(fields.voucher_no ?? ""),
    PESOWISE_DPR_PROJECT_ID: String(meta.project_id ?? ""),
    PESOWISE_DPR_PROJECT_NAME: String(fields.project_name ?? ""),
    PESOWISE_DPR_EMPLOYEE: String(fields.employee_name ?? ""),
    PESOWISE_DPR_EMPLOYEE_CODE: String(fields.employee_code ?? ""),
    PESOWISE_DPR_LOCATION: String(fields.location ?? ""),
    PESOWISE_DPR_REMARKS: resolveRemarks(fields, fields),
    PESOWISE_DPR_PETROL_COST: num("petrol_cost"),
    PESOWISE_DPR_MATERIAL_COST: num("material_cost"),
    PESOWISE_DPR_TRAVELLING_COST: num("travelling_cost"),
    PESOWISE_DPR_PHONE_EXP: num("phone_exp"),
    PESOWISE_DPR_HOTEL_EXP: num("hotel_exp"),
    PESOWISE_DPR_TRANSPORT_EXP: num("transport_exp"),
    PESOWISE_DPR_CONTRA_BILL: num("contra_bill"),
    PESOWISE_DPR_OTHER_EXP: num("other_exp"),
    PESOWISE_DPR_PERCENT: payrollPercent(fields, fields),
    PESOWISE_DPR_PRESENCE: "P",
  };
  const udfXml = Object.entries(udfs)
    .map(
      ([k, v]) =>
        `<UDF:${k} TYPE="String">${escapeXmlText(v)}</UDF:${k}>`,
    )
    .join("");
  const inner = `<TALLYMESSAGE xmlns:UDF="TallyUDF"><LEDGER ACTION="Alter"><NAME.LIST><NAME>${escapeXmlText(name)}</NAME></NAME.LIST>${udfXml}</LEDGER></TALLYMESSAGE>`;
  return `<?xml version="1.0"?><ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME><STATICVARIABLES></STATICVARIABLES></REQUESTDESC><REQUESTDATA>${inner}</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
}

const names = await ledgerNamesFromDb();
console.log(JSON.stringify({ ledger_names_from_db: names.length }, null, 2));
if (names.length === 0) {
  console.error("No ledger names in tally_delivery_state — deliver Daily Project sync first.");
  process.exit(1);
}

let ok = 0;
let skip = 0;
let fail = 0;
for (const name of names) {
  const ex = await exportLedger(name);
  if (ex.includes("TallyPrime Server is Running") && !ex.includes("LEDGER")) {
    console.error(
      "Tally HTTP has no company loaded. Open TallyPrime → PesoWise Integration Test → enable ODBC/HTTP for this company, then re-run.",
    );
    process.exit(2);
  }
  const meta = parseMetaJson(ex);
  if (!meta || meta.report_type !== "daily_project_report") {
    skip += 1;
    continue;
  }
  const resp = await postXml(buildAlter(name, meta), 30_000);
  const altered = Number(resp.match(/<ALTERED>(\d+)<\/ALTERED>/i)?.[1] ?? 0);
  const exc = Number(resp.match(/<EXCEPTIONS>(\d+)<\/EXCEPTIONS>/i)?.[1] ?? 0);
  if (altered > 0 && exc === 0) ok += 1;
  else {
    fail += 1;
    if (process.env.BACKFILL_VERBOSE === "1" && fail === 1) {
      console.log(JSON.stringify({ sample_fail: { name, export_bytes: ex.length, resp: resp.slice(0, 500) } }));
    }
  }
  if ((ok + skip + fail) % 100 === 0) {
    console.log(JSON.stringify({ ok, skip, fail }));
  }
}
console.log(JSON.stringify({ done: true, ok, skip, fail }, null, 2));
