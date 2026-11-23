import { describe, expect, it } from "vitest";
import { analyzeCompanyVerifyResponse } from "../../../connector/tally/src/tallyCompanyVerify.offline.js";

const COMPANY = "PesoWise Integration Test";

/** Offline parser fixtures only — not used at runtime after c0000005 incident. */
describe("Tally company XML parsers (offline)", () => {
  it("exact company present in object export -> nameMatched", () => {
    const xml = `<ENVELOPE><BODY><COMPANY><NAME>${COMPANY}</NAME></COMPANY></BODY></ENVELOPE>`;
    expect(analyzeCompanyVerifyResponse(COMPANY, xml).nameMatched).toBe(true);
  });

  it("wrong company -> couldNotFindCompany", () => {
    const xml = `<ERRORMSG>Could not find Company:Wrong Co!</ERRORMSG>`;
    expect(analyzeCompanyVerifyResponse(COMPANY, xml).couldNotFindCompany).toBe(true);
  });

  it("malformed / line error", () => {
    const xml = `<ENVELOPE><BODY><LINEERROR>bad request</LINEERROR></BODY></ENVELOPE>`;
    expect(analyzeCompanyVerifyResponse(COMPANY, xml).lineError).toBe(true);
  });
});
