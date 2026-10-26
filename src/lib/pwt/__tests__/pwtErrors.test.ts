import { describe, expect, it, afterEach, vi } from "vitest";
import { classifyPwtError, describePwtError, functionErrorText } from "../pwtErrors";
import { friendlyTallyError } from "../pwtSync";

describe("describePwtError", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("says what went wrong and what to do for each kind of failure", () => {
    const cases: Array<[unknown, string, RegExp]> = [
      [new TypeError("Failed to fetch"), "network", /Cannot reach the PesoWise server.*internet connection/],
      [{ message: "JWT expired" }, "session", /login has expired.*sign in again/],
      [{ message: "permission denied for function pwt_list_jobs_v1", code: "42501" }, "permission", /do not have permission.*administrator/],
      [{ message: "no Tally connector is paired for this organisation" }, "not_paired", /No Tally connector is paired.*Tally setup/],
      [{ message: "PesoWise API 401: invalid or expired pairing code" }, "bad_code", /wrong or has expired.*15 minutes/],
      [{ message: "canceling statement due to statement timeout" }, "too_large", /too large.*shorter period.*one month/],
      [{ message: "Could not find the function public.pwt_list_connectors_v1(p_organization_id) in the schema cache" }, "server_setup", /not fully set up.*administrator/],
      [{ message: "HTTP 429 Too Many Requests" }, "rate_limit", /Too many requests.*minute/],
      [{ message: "Request timed out" }, "timeout", /did not answer in time/],
      [{ message: "tally_offline" }, "tally_offline", /TallyPrime cannot be reached.*Tally port/],
      [{ message: "Edge Function returned a non-2xx status code" }, "server", /The server had a problem.*try again/i],
    ];
    for (const [err, kind, text] of cases) {
      expect(classifyPwtError(err), String((err as { message?: string }).message ?? err)).toBe(kind);
      expect(describePwtError(err)).toMatch(text);
    }
  });

  it("keeps a clear sentence the server wrote and falls back for unreadable text", () => {
    expect(describePwtError(new Error("The voucher type name is required"), "fallback")).toBe("The voucher type name is required");
    expect(describePwtError(new Error("{\"a\":1} at foo.ts:12\nstack"), "Try again later.")).toBe("Try again later.");
    expect(describePwtError(undefined, "Something happened.")).toBe("Something happened.");
  });

  it("reports being offline before anything else", () => {
    vi.stubGlobal("navigator", { onLine: false });
    expect(describePwtError(new Error("whatever"))).toMatch(/Cannot reach the PesoWise server/);
  });

  it("reads the server's explanation from a failed edge-function call, else uses the status", async () => {
    const withBody = { message: "Edge Function returned a non-2xx status code", context: new Response(JSON.stringify({ error: "no Tally connector is paired for this organisation" }), { status: 400 }) };
    expect(await functionErrorText(withBody)).toMatch(/No Tally connector is paired/);
    const plain = { message: "Edge Function returned a non-2xx status code", context: new Response("", { status: 401 }) };
    expect(await functionErrorText(plain)).toMatch(/login has expired/);
    const own = { message: "x", context: new Response(JSON.stringify({ error: "organization_id is required" }), { status: 400 }) };
    expect(await functionErrorText(own)).toBe("organization_id is required");
  });

  it("job errors keep the voucher number for a conflict and turn technical text into advice", () => {
    expect(friendlyTallyError("Voucher PESO/08/01 already exists in Tally with different amounts - manual review needed"))
      .toMatch(/Voucher PESO\/08\/01 already exists in Tally with different amounts\. Open that voucher in Tally/);
    expect(friendlyTallyError("canceling statement due to statement timeout")).toMatch(/too large/);
    expect(friendlyTallyError("something plain the connector said")).toBe("something plain the connector said");
  });
});
