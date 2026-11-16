import http from "http";

const marker = "Phase51 balanced meta PW-META-BAL";

function decodeXmlText(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function post(xml, ms = 120_000) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: 9000, method: "POST", headers: { "Content-Type": "text/xml;charset=utf-8" } },
      (res) => {
        const ch = [];
        res.on("data", (d) => ch.push(d));
        res.on("end", () => resolve(Buffer.concat(ch).toString("utf8")));
      },
    );
    req.setTimeout(ms, () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.write(xml);
    req.end();
  });
}

const c = "PesoWise Integration Test".replace(/&/g, "&amp;").replace(/</g, "&lt;");
const xml = `<?xml version="1.0"?><ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>VOUCHER</ID></HEADER><BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>${c}</SVCURRENTCOMPANY><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT><SVFROMDATE>20260406</SVFROMDATE><SVTODATE>20260406</SVTODATE></STATICVARIABLES></DESC></BODY></ENVELOPE>`;

const t = await post(xml);
console.log("export_len", t.length, "has_marker", t.includes(marker));
const idx = t.indexOf(marker);
if (idx >= 0) console.log("context_excerpt", t.slice(Math.max(0, idx - 200), idx + 400));
const m =
  t.match(/<PESOWISE_METADATA_JSON[^>]*>([\s\S]*?)<\/PESOWISE_METADATA_JSON>/i) ??
  t.match(/<UDF:PESOWISE_METADATA_JSON[^>]*>([\s\S]*?)<\/UDF:PESOWISE_METADATA_JSON>/i);
if (m) {
  const raw = decodeXmlText(m[1].trim());
  console.log("udf_json_excerpt", raw.slice(0, 300));
  try {
    const o = JSON.parse(raw);
    console.log("roundtrip_token", o.roundtrip_token);
    console.log("fields_note", o.fields?.note);
  } catch (e) {
    console.log("json_parse_fail", e.message);
  }
} else console.log("udf_not_found_in_export");
