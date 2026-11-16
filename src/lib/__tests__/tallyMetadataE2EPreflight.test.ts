import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { mapPreparedJobItems } from "@/lib/tallyMapping/pipeline";
import { metadataVersionLedgerName, reportMetadataDeliveryKey, tallyReportMetadataDeliveryHash } from "@/lib/tallyMapping/identities";
import {
  claimApprovalItem,
  claimVerificationItem,
  dailyProjectItem,
  detailedExpenseDeductionItem,
} from "@/lib/tallyMapping/__fixtures__/synthetic";
import { stableStringify } from "@/lib/tallySync/contentHash";
import {
  CLAIM_APPROVAL_LIST_COLUMNS,
  CLAIM_LIST_COLUMNS,
  DAILY_LIST_COLUMNS,
  DETAILED_LIST_COLUMNS,
} from "@/lib/tallyMapping/tallyReportUiContract";
import { mapPreparedJobItems as mapPreparedJobItemsEdge } from "../../../supabase/functions/_shared/tallyMapping/pipeline.ts";

const SMOKE_ORG = "80ab039f-f9e2-4c76-8b5b-e65b15d66af9";

describe("Metadata E2E preflight (offline)", () => {
  it("Daily Project collection uses the populated report-type UDF for row selection", () => {
    const common = readFileSync(resolve(process.cwd(), "tally-extension/tdl/02-common.tdl"), "utf8");
    const collections = readFileSync(resolve(process.cwd(), "tally-extension/tdl/03-collections.tdl"), "utf8");
    const dailyCollection = collections.match(/\[Collection : PWDPRLatest\]([\s\S]*?)(?=\n\[Collection|$)/)?.[1] ?? "";
    expect(common).toContain('PWFiltClaimVer : $PESOWISE_REPORT_TYPE = "claim_verification"');
    expect(common).toContain('PWFiltClaimAp : $PESOWISE_REPORT_TYPE = "claim_approval"');
    expect(common).toContain('PWFiltDetailed : $PESOWISE_REPORT_TYPE = "detailed_expense"');
    expect(common).toContain("PWFiltDaily : NOT $$IsEmpty:$PESOWISE_DPR_TRACK_DATE");
    expect(dailyCollection).not.toContain("Filter Var :");
    expect(common + dailyCollection).not.toContain("$$StringEqual");
    expect(dailyCollection).toContain("Filter : PWFiltDaily");
    expect(dailyCollection).not.toContain("Filter : PWFiltDPRTrack");
    expect(dailyCollection).not.toContain("Child Of :");
    expect(dailyCollection.indexOf("Fetch : Name, PESOWISE_REPORT_TYPE")).toBeLessThan(
      dailyCollection.indexOf("Filter : PWFiltDaily"),
    );

    const dailyReport = readFileSync(resolve(process.cwd(), "tally-extension/tdl/07-daily-project.tdl"), "utf8");
    expect(dailyReport).toContain("Repeat : PW DPR Data Line : PWDPRLatest");
    expect(dailyReport).toMatch(/Use : Number Field\r?\nSet as : \$\$NumItems:PWDPRLatest/);
    for (let index = 1; index <= 23; index++) {
      const block = dailyReport.match(new RegExp(`\\[Field : PW DPR D${index}\\]([\\s\\S]*?)(?=\\r?\\n\\[|$)`))?.[1] ?? "";
      expect(block, `daily report column ${index} uses the canonical row position`).toContain(`$$PWCVFlatToken:$PESOWISE_REPORT_FLAT_ROW:${index}`);
      expect(block).not.toMatch(/Set as : .*\$PESOWISE_DPR_/);
    }
    expect(dailyReport).toContain("Fields : PW DPR D1, PW DPR D2, PW DPR D3");
    expect(dailyReport).toMatch(/\[Part : PW DPR Grid Part\]\r?\nLines : PW DPR Col Head Line, PW DPR Data Line\r?\nRepeat : PW DPR Data Line : PWDPRLatest\r?\nScroll : Both/);
    expect((dailyReport.match(/\[Field : PW DPR D\d+\]/g) ?? [])).toHaveLength(23);

    // Cost UDFs are persisted as String. Render them as Number values so Tally
    // does not try to interpret text UDFs as company-currency Amounts.
    const expenseColumns = [
      ["D14", "V9", "PETROL_COST"], ["D15", "V10", "MATERIAL_COST"],
      ["D16", "V11", "TRAVELLING_COST"], ["D17", "V12", "PHONE_EXP"],
      ["D18", "V13", "HOTEL_EXP"], ["D19", "V14", "TRANSPORT_EXP"],
      ["D20", "V15", "CONTRA_BILL"], ["D21", "V16", "OTHER_EXP"],
      ["V17", "V17", "TOTAL_EXPENSE"],
    ];
    const flatIndexMap = {
      PETROL_COST: 14, MATERIAL_COST: 15, TRAVELLING_COST: 16, PHONE_EXP: 17,
      HOTEL_EXP: 18, TRANSPORT_EXP: 19, CONTRA_BILL: 20, OTHER_EXP: 21,
    } as const;
    for (const [listField, detailField, udf] of expenseColumns) {
      for (const fieldName of new Set([`PW DPR ${listField}`, `PW DPR ${detailField}`])) {
        const block = dailyReport.match(new RegExp(`\\[Field : ${fieldName}\\]([\\s\\S]*?)(?=\\r?\\n\\[|$)`))?.[1] ?? "";
        expect(block, `${fieldName} must render a numeric UDF as a number`).toContain("Use : Number Field");
        if (udf === "TOTAL_EXPENSE") {
          expect(block).toContain(`Set as : $$Number:($PESOWISE_DPR_${udf})`);
        } else {
          const flatIndex = flatIndexMap[udf as keyof typeof flatIndexMap];
          expect(block).toContain(`$$Number:($$PWCVFlatToken:$PESOWISE_REPORT_FLAT_ROW:${flatIndex})`);
        }
      }
    }
  });

  it("all report collections avoid the Tally 7 Child Of scope that hides persisted rows", () => {
    const collections = readFileSync(resolve(process.cwd(), "tally-extension/tdl/03-collections.tdl"), "utf8");
    const expected: [string, string][] = [
      ["PW Claim Ver Latest", "PWFiltClaimVer"],
      ["PW Claim Ap Latest", "PWFiltClaimAp"],
      ["PW Detailed Latest", "PWFiltDetailed"],
    ];
    for (const [name, filter] of expected) {
      const block = collections.match(new RegExp(`\\[Collection : ${name}\\]([\\s\\S]*?)(?=\\n\\[Collection|$)`))?.[1] ?? "";
      expect(block, `${name} must exist`).not.toBe("");
      expect(block, `${name} must scan ledgers globally`).not.toContain("Child Of :");
      expect(block, `${name} must still isolate its own metadata type`).toContain(`Filter : ${filter}`);
      expect(block.indexOf("Fetch : Name, PESOWISE_REPORT_TYPE")).toBeLessThan(block.indexOf(`Filter : ${filter}`));
    }
    const selectedLedger = collections.match(/\[Collection : PW Selected Ledger One\]([\s\S]*?)(?=\n\[Collection|$)/)?.[1] ?? "";
    expect(selectedLedger).not.toContain("Child Of :");
    expect(selectedLedger).toContain("Filter : PWSelLedgerMatch");
    expect(selectedLedger.indexOf("Fetch : Name")).toBeLessThan(selectedLedger.indexOf("Filter : PWSelLedgerMatch"));
    const common = readFileSync(resolve(process.cwd(), "tally-extension/tdl/02-common.tdl"), "utf8");
    expect(common).toContain("PWSelLedgerMatch : $Name = ##SVPWLedgerName");
    for (const [file, prefix, detailReport] of [
      ["04-claim-verification.tdl", "PW CV", "PW Claim Verification Detail"],
      ["05-claim-approval.tdl", "PW CA", "PW Claim Approval Detail"],
      ["06-detailed-expense.tdl", "PW DE", "PW Detailed Expense Detail"],
      ["07-daily-project.tdl", "PW DPR", "PW Daily Project Detail"],
    ]) {
      const report = readFileSync(resolve(process.cwd(), `tally-extension/tdl/${file}`), "utf8");
      expect(report).toContain(`01 : SET : SV PW Ledger Name : $Name`);
      expect(report).toContain(`02 : Display : ${detailReport}`);
      expect(report).toContain(`Repeat : ${prefix} Det Block : PW Selected Ledger One`);
    }
  });

  it("Detailed Expense list and drill-down use the persisted 20-token row as authoritative", () => {
    const report = readFileSync(resolve(process.cwd(), "tally-extension/tdl/06-detailed-expense.tdl"), "utf8");
    const columns = ["EMPLOYEE", "EMPLOYEE_CODE", "DATE", "TRANSACTION", "TITLE", "EVENT", "CATEGORY", "PURPOSE", "DESTINATION", "BATCH", "FROM_LOCATION", "PROJECT_ID", "PROJECT_NAME", "PROJECT_UNIQUE_ID", "TO_LOCATION", "CREDIT", "DEBIT", "NOTE", "OPENING", "CLOSING"];
    for (let index = 1; index <= columns.length; index++) {
      const list = report.match(new RegExp(`\\[Field : PW DE D${index}\\]([\\s\\S]*?)(?=\\r?\\n\\[|$)`))?.[1] ?? "";
      expect(list, `list field D${index}`).toContain(`$$PWCVFlatToken:$PESOWISE_REPORT_FLAT_ROW:${index}`);
      expect(list, `list field D${index} ignores possibly stale typed UDF slots`).not.toMatch(/else\s+\$PESOWISE_/);
      const detail = report.match(new RegExp(`\\[Field : PW DE Det V${index}\\]([\\s\\S]*?)(?=\\r?\\n\\[|$)`))?.[1] ?? "";
      expect(detail, `detail field V${index}`).toContain(`$$PWCVFlatToken:$PESOWISE_REPORT_FLAT_ROW:${index}`);
      expect(detail, `detail field V${index} ignores possibly stale typed UDF slots`).not.toMatch(/else\s+\$PESOWISE_/);
      if ([16, 17, 19, 20].includes(index)) {
        expect(list).toContain("$$Number:($$PWCVFlatToken:");
        expect(detail).toContain("$$Number:($$PWCVFlatToken:");
      }
    }
  });

  it("claim flat-row fallback counts tokens explicitly instead of depending on an ambient loop index", () => {
    const common = readFileSync(resolve(process.cwd(), "tally-extension/tdl/02-common.tdl"), "utf8");
    const tokenFn = common.match(/\[Function : PWCVFlatToken\]([\s\S]*?)(?=\n\[|$)/)?.[1] ?? "";
    expect(tokenFn).toMatch(/Parameter : PWCVTokenIndex : Number\r?\nReturns : String/);
    expect(tokenFn).toContain("Variable : PWCVTokenCounter : Number");
    expect(tokenFn).not.toContain("Variable : PWCVToken : String");
    expect(tokenFn).toContain("SET : PWCVTokenCounter : 0");
    expect(tokenFn).toContain("FOR TOKEN : PWCVToken : ##PWCVFlatRow : \"|\"");
    expect(tokenFn).toContain("INCREMENT : PWCVTokenCounter");
    expect(tokenFn).toContain("IF : ##PWCVTokenCounter = ##PWCVTokenIndex");
    expect(tokenFn).toContain('IF : ##PWCVToken = "__PW_EMPTY__"');
    expect(tokenFn).toContain('IF : ##PWCVToken = "__PW_EMPTY____PW_EMPTY__"');
    expect(tokenFn).not.toContain("$$LoopIndex");
  });

  it("all four Tally grids expose the complete fixed PesoWise row fields", () => {
    const expected: [string, number][] = [
      ["04-claim-verification.tdl", 19],
      ["05-claim-approval.tdl", 19],
      ["06-detailed-expense.tdl", 20],
      ["07-daily-project.tdl", 23],
    ];
    for (const [file, count] of expected) {
      const tdl = readFileSync(resolve(process.cwd(), `tally-extension/tdl/${file}`), "utf8");
      expect((tdl.match(/\[Field : PW (?:CV|CA|DE|DPR) D\d+\]/g) ?? [])).toHaveLength(count);

      // The flat row is emitted in the exact source export order. It is the
      // authoritative display snapshot; older individual UDF slots can have
      // stale values or collide with definitions loaded by earlier TDL builds.
      const prefix = file.startsWith("04-") ? "PW CV" : file.startsWith("05-") ? "PW CA" : file.startsWith("06-") ? "PW DE" : "PW DPR";
      const numericIndexes = file.startsWith("04-") || file.startsWith("05-")
        ? new Set([12, 17, 18])
        : file.startsWith("06-")
          ? new Set([16, 17, 19, 20])
          : new Set([14, 15, 16, 17, 18, 19, 20, 21]);
      for (let index = 1; index <= count; index++) {
        const field = tdl.match(new RegExp(`\\[Field : ${prefix} D${index}\\]([\\s\\S]*?)(?=\\r?\\n\\[|$)`))?.[1] ?? "";
        const token = `$$PWCVFlatToken:$PESOWISE_REPORT_FLAT_ROW:${index}`;
        expect(field, `${file} column ${index} must use its canonical source position`).toContain(token);
        expect(field, `${file} column ${index} must not prefer an old display UDF`).not.toMatch(/Set as : .*else\s+\$PESOWISE_/);
        if (numericIndexes.has(index)) expect(field, `${file} numeric column ${index}`).toContain(`$$Number:(${token})`);
      }

      // Fixed form/part widths squeeze a 19–23 column line to fit, which makes
      // headers and values overlap. Let content define the horizontal extent;
      // Scroll: Both provides the on-screen viewport and navigation.
      const listForm = tdl.match(new RegExp(`\\[Form : ${prefix} List Form\\]([\\s\\S]*?)(?=\\r?\\n\\[|$)`))?.[1] ?? "";
      const gridPart = tdl.match(new RegExp(`\\[Part : ${prefix} Grid Part\\]([\\s\\S]*?)(?=\\r?\\n\\[|$)`))?.[1] ?? "";
      expect(listForm).not.toMatch(/^Width\s*:/m);
      expect(gridPart).toContain("Scroll : Both");
      expect(gridPart).not.toMatch(/^Width\s*:/m);

      // Tally reports objects are globally named within the loaded TDL set. A
      // duplicate definition makes the entire load fail with T0009.
      const definitions = [...tdl.matchAll(/^\[(?:Part|Line|Field|Function|Report|Form|Key|Collection)\s*:\s*([^\]]+)\]/gm)]
        .map((match) => match[1].trim());
      const duplicateDefinitions = definitions.filter((name, index) => definitions.indexOf(name) !== index);
      expect(duplicateDefinitions, `${file} must not define any TDL object twice`).toEqual([]);
    }

    for (const item of [claimVerificationItem(), claimApprovalItem(), detailedExpenseDeductionItem()]) {
      const mapped = mapPreparedJobItems([item], {
        organization_id: item.payload.organization_id,
        job_id: "display-udf-preflight",
        presentation_only: true,
      });
      const metadata = mapped.commands.find((command) => command.kind === "report_metadata");
      expect(metadata?.kind).toBe("report_metadata");
      if (metadata?.kind === "report_metadata") {
        expect(metadata.metadata.display_udfs.length).toBeGreaterThan(10);
        expect(metadata.metadata.display_udfs.some((udf) => udf.name.startsWith("PESOWISE_CLAIM_") || udf.name.startsWith("PESOWISE_DE_"))).toBe(true);
        const names = metadata.metadata.display_udfs.map((udf) => udf.name);
        if (item.payload.report_type === "claim_verification" || item.payload.report_type === "claim_approval") {
          expect(names).toContain("PESOWISE_CLAIM_EMPLOYEE");
          expect(names).toContain("PESOWISE_CLAIM_AMOUNT");
          expect(metadata.metadata.display_udfs.find((udf) => udf.name === "PESOWISE_CLAIM_EMPLOYEE")?.value).toBe("Ravi & Co <test>");
        } else {
          expect(names).toContain("PESOWISE_DE_EMPLOYEE");
          expect(names).toContain("PESOWISE_DE_AMOUNT");
          expect(metadata.metadata.display_udfs.find((udf) => udf.name === "PESOWISE_DE_AMOUNT")?.value).toBe("1500.50");
        }
      }
    }
  });

  it("renders string-backed amount and balance UDFs as numeric fields in all four reports", () => {
    const fields = [
      ["04-claim-verification.tdl", ["PW CV D12", "PW CV D17", "PW CV D18", "PW CV Det V12", "PW CV Det V17", "PW CV Det V18"]],
      ["05-claim-approval.tdl", ["PW CA D12", "PW CA D17", "PW CA D18", "PW CA Det V12", "PW CA Det V17", "PW CA Det V18"]],
      ["06-detailed-expense.tdl", ["PW DE D16", "PW DE D17", "PW DE D19", "PW DE D20", "PW DE Det V16", "PW DE Det V17", "PW DE Det V19", "PW DE Det V20"]],
      ["07-daily-project.tdl", [...Array.from({ length: 8 }, (_, i) => `PW DPR D${i + 14}`), ...Array.from({ length: 9 }, (_, i) => `PW DPR V${i + 9}`)]],
    ] as const;
    for (const [file, names] of fields) {
      const tdl = readFileSync(resolve(process.cwd(), `tally-extension/tdl/${file}`), "utf8");
      for (const name of names) {
        const field = tdl.match(new RegExp(`\\[Field : ${name}\\]([\\s\\S]*?)(?=\\r?\\n\\[|$)`))?.[1] ?? "";
        expect(field, `${file}:${name} should use Number Field`).toContain("Use : Number Field");
        expect(field, `${file}:${name} should explicitly convert the stored string`).toContain("$$Number:");
        expect(field).not.toContain("$$AsAmount:");
      }
    }
  });

  it("keeps report headings and rows in one horizontally scrolling grid", () => {
      const reports = [
      ["04-claim-verification.tdl", "PW CV", "PW Claim Ver Latest", [18, 13, 24, 14, 20, 24, 18, 16, 14, 11, 11, 12, 16, 18, 16, 12, 14, 14, 16]],
      ["05-claim-approval.tdl", "PW CA", "PW Claim Ap Latest", [18, 13, 24, 14, 20, 24, 18, 16, 14, 11, 11, 12, 16, 18, 16, 12, 14, 14, 16]],
      ["06-detailed-expense.tdl", "PW DE", "PW Detailed Latest", [18, 14, 11, 14, 22, 16, 14, 24, 18, 16, 18, 14, 24, 20, 18, 13, 13, 24, 14, 14]],
        ["07-daily-project.tdl", "PW DPR", "PWDPRLatest", [11, 13, 16, 20, 18, 14, 16, 14, 10, 12, 10, 24, 24, 13, 13, 13, 13, 13, 13, 13, 13, 16, 10]],
      ] as const;
      for (const [file, prefix, collection, columnWidths] of reports) {
      const tdl = readFileSync(resolve(process.cwd(), `tally-extension/tdl/${file}`), "utf8");
      const grid = tdl.match(new RegExp(`\\[Part : ${prefix} Grid Part\\]([\\s\\S]*?)(?=\\r?\\n\\[|$)`))?.[1] ?? "";
        expect(grid, `${file} puts header and repeated data rows in one part`).toContain(`Lines : ${prefix} Col Head Line, ${prefix} Data Line`);
        expect(grid, `${file} repeats data rows from the report collection`).toContain(`Repeat : ${prefix} Data Line : ${collection}`);
        expect(grid, `${file} scrolls rows and columns together`).toContain("Scroll : Both");
      expect(grid, `${file} leaves the repeated columns at their natural width`).not.toMatch(/^Width\s*:/m);
      const listForm = tdl.match(new RegExp(`\\[Form : ${prefix} List Form\\]([\\s\\S]*?)(?=\\r?\\n\\[|$)`))?.[1] ?? "";
      expect(listForm, `${file} does not squeeze the full report into a fixed form width`).not.toMatch(/^Width\s*:/m);
        expect(grid, `${file} keeps row boundaries visible`).toContain("Common Border : Yes");
      expect(tdl, `${file} gives the report form the full screen height`).toContain("Height : 100% Screen");
      const listFields = [...tdl.matchAll(new RegExp(`\\[Field : ${prefix} [CD]\\d+\\]([\\s\\S]*?)(?=\\r?\\n\\[|$)`, "g"))].map((match) => match[1]);
      expect(listFields.length, `${file} exposes list fields`).toBeGreaterThan(0);
        expect(listFields, `${file} heading and row field counts match declared columns`).toHaveLength(columnWidths.length * 2);
        for (let index = 0; index < listFields.length; index += 1) {
          const field = listFields[index];
          expect(field, `${file} column ${index + 1} has a character-based width`).toContain(`Width : ${columnWidths[index % columnWidths.length]}`);
        expect(field.match(/Space Left :/g) ?? []).toHaveLength(1);
        expect(field).toContain("Space Left : 2");
          if (index < columnWidths.length) expect(field).toContain("Style : PW List Head Style");
          else expect(field).toContain("Style : PW List Row Style");
      }
      const nonListPercentWidths = [...tdl.matchAll(new RegExp(`\\[Field : (?!${prefix} [CD]\\d+)[^\\]]+\\]([\\s\\S]*?)(?=\\r?\\n\\[|$)`, "g"))]
          .flatMap((match) => match[1].match(/Width : \d+% Screen/g) ?? []);
      expect(nonListPercentWidths, `${file} does not apply list sizing to diagnostic or detail fields`).toHaveLength(0);
      const textRows = [...tdl.matchAll(new RegExp(`\\[Field : ${prefix} D\\d+\\]([\\s\\S]*?)(?=\\r?\\n\\[|$)`, "g"))].map((match) => match[1]).filter((field) => field.includes("Use : Name Field"));
      for (const field of textRows) expect(field).toContain("Max Display Lines : 2");
    }
  });

  it("all four loaded TDL column labels match the PesoWise report contracts in order", () => {
    const specs = [
      ["04-claim-verification.tdl", "CV", CLAIM_LIST_COLUMNS],
      ["05-claim-approval.tdl", "CA", CLAIM_APPROVAL_LIST_COLUMNS],
      ["06-detailed-expense.tdl", "DE", DETAILED_LIST_COLUMNS],
      ["07-daily-project.tdl", "DPR", DAILY_LIST_COLUMNS],
    ] as const;

    const fieldBlock = (source: string, fieldName: string) => {
      const escaped = fieldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return source.match(new RegExp(`\\[Field : ${escaped}\\]([\\s\\S]*?)(?=\\r?\\n\\[|$)`))?.[1] ?? "";
    };

    for (const [file, prefix, columns] of specs) {
      const source = readFileSync(resolve(process.cwd(), `tally-extension/tdl/${file}`), "utf8");
      const bundle = readFileSync(resolve(process.cwd(), `connector/tally/bundle/tdl/${file}`), "utf8");
      expect(bundle, `${file} bundled TDL must match its tested source`).toBe(source);

      const headerLine = source.match(new RegExp(`\\[Line : PW ${prefix} Col Head Line\\]([\\s\\S]*?)(?=\\r?\\n\\[|$)`))?.[1] ?? "";
      const fieldOrder = headerLine.match(/Fields : (.+)/)?.[1]?.split(/,\s*/) ?? [];
      const tallyLabels = fieldOrder.map((fieldName) => {
        const field = fieldBlock(source, fieldName);
        return field.match(/Set as : "([^"]*)"/)?.[1] ?? "";
      });
      expect(tallyLabels, `${file} must preserve PesoWise column order and labels`).toEqual(
        columns.map((column) => column.label),
      );
    }
  });

  it("frontend and deployed Edge mapping produce identical typed report UDFs", () => {
    for (const item of [claimVerificationItem(), claimApprovalItem(), detailedExpenseDeductionItem()]) {
      const options = {
        organization_id: item.payload.organization_id,
        job_id: "edge-display-udf-parity",
        presentation_only: true,
      };
      const source = mapPreparedJobItems([item], options).commands.find((command) => command.kind === "report_metadata");
      const edge = mapPreparedJobItemsEdge([item], options).commands.find((command) => command.kind === "report_metadata");
      expect(source?.kind).toBe("report_metadata");
      expect(edge?.kind).toBe("report_metadata");
      if (source?.kind === "report_metadata" && edge?.kind === "report_metadata") {
        expect(edge.metadata.display_udfs).toEqual(source.metadata.display_udfs);
      }
    }
  });

  it("daily project job produces no voucher commands", () => {
    const item = { ...dailyProjectItem("preflight-hash-1"), payload: { ...dailyProjectItem().payload, organization_id: SMOKE_ORG } };
    const mapped = mapPreparedJobItems([item], {
      organization_id: SMOKE_ORG,
      job_id: "preflight-job",
      sync_run_id: "preflight-sync-run",
    });
    expect(mapped.accounting_voucher_count).toBe(0);
    expect(mapped.commands.some((c) => c.kind === "voucher")).toBe(false);
  });

  it("representative batch XML: All Masters import, metadata LEDGER Create, no VOUCHER", () => {
    const item = dailyProjectItem("preflight-hash-2");
    item.payload.organization_id = SMOKE_ORG;
    const mapped = mapPreparedJobItems([item], {
      organization_id: SMOKE_ORG,
      job_id: "preflight-job",
      sync_run_id: "preflight-sync-run",
    });
    const batch0 = mapped.xml_batches[0];
    expect(batch0.message_count).toBeGreaterThan(0);
    const xml = batch0.xml.replace(
      "<SVCURRENTCOMPANY><!-- configured at connector time --></SVCURRENTCOMPANY>",
      "<SVCURRENTCOMPANY>PesoWise Integration Test</SVCURRENTCOMPANY>",
    );
    expect(xml).toContain("REPORTNAME>All Masters");
    expect(xml).toContain("PesoWise Integration Test");
    expect(xml).not.toContain("<GROUP ACTION=\"Create\"");
    expect(xml).toContain("<PARENT>PesoWise Metadata</PARENT>");
    expect(xml).toContain("<LEDGER ACTION=\"Create\"");
    expect(xml).toContain("PESOWISE_METADATA_JSON");
    expect(xml).toContain('<UDF:PESOWISE_METADATA_JSON TYPE="String">');
    expect(xml).toContain('<UDF:PESOWISE_SYNC_RUN_ID TYPE="String">preflight-sync-run</UDF:PESOWISE_SYNC_RUN_ID>');
    const bootstrap = readFileSync(resolve(process.cwd(), "tally-extension/PesoWise-Bootstrap.tdl"), "utf8");
    expect(bootstrap).toContain("PESOWISE_METADATA_JSON : String : 25001");
    expect(bootstrap).toContain("PESOWISE_META_JSON_PLAIN : String : 25029");
    expect(bootstrap).toContain("PESOWISE_SYNC_RUN_ID : String : 25030");
    expect(bootstrap).not.toContain("PESOWISE_SYNC_RUN : String : 25030");
    expect(xml).not.toContain("<VOUCHER");
    expect(xml).not.toContain("ALLLEDGERENTRIES");
    expect(xml).not.toMatch(/Load Company/i);
    expect(xml).not.toContain('ACTION="Alter"');

    const meta = mapped.commands.find((c) => c.kind === "report_metadata");
    expect(meta?.kind).toBe("report_metadata");
    if (meta?.kind === "report_metadata") {
      const metaKey = reportMetadataDeliveryKey(SMOKE_ORG, "daily_project_report", item.source_key);
      expect(meta.metadata.ledger_name).toBe(metadataVersionLedgerName(metaKey, tallyReportMetadataDeliveryHash(item.content_hash, "daily_project_report")));
      expect(meta.metadata.action).toBe("create");
      const json = stableStringify(meta.metadata.payload);
      expect(json).toContain("metadata_delivery_key");
      expect(json).toContain("content_hash");
      expect(json).toContain("metadata_revision");
      expect(xml).toContain(meta.metadata.ledger_name);
    }
  });

  it("claim RPC scopes batches to connector device organization", () => {
    const sql = readFileSync(
      resolve(process.cwd(), "supabase/migrations/20261007150000_tally_metadata_revision.sql"),
      "utf-8",
    );
    expect(sql).toContain("connector_claim_delivery_batch_v1");
    expect(sql).toMatch(/FROM public.tally_connector_devices[\s\S]*organization_id INTO v_org/);
    expect(sql).toMatch(/b\.organization_id = v_org/);
    expect(sql).not.toMatch(/6709c1fe-e8c8-404d-bc68-d1edda923344/);
  });

  it("agent delivery uses a single postImportXmlOnce without a retry wrapper", () => {
    const loop = readFileSync(resolve(process.cwd(), "connector/tally/src/serviceLoop.ts"), "utf-8");
    const delivery = readFileSync(resolve(process.cwd(), "connector/tally/src/deliverBatch.ts"), "utf-8");
    expect(delivery.match(/postImportXmlOnce\(xml\)/g)?.length).toBe(1);
    expect(delivery.indexOf("verifyActiveCompany(configuredCompany)")).toBeLessThan(delivery.indexOf("postImportXmlOnce(xml)"));
    expect(loop).toContain("verifyActiveCompany");
  });
});
