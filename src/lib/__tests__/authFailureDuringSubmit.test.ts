/**
 * Auth failure during an expense submit must integrate with the stranded-draft fix
 * (DOC-148): session dies between the draft being resolved and the final submit; the app recovers
 * ONCE; the user signs in again; the retry carries the SAME logical id and lands on the SAME row.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const signOut = vi.fn().mockResolvedValue({ error: null });
vi.mock("@/integrations/supabase/client", () => ({ supabase: { auth: { signOut: (...a: unknown[]) => signOut(...a) } } }));

import { recoverFromInvalidAuthSession, resetSessionExpiredNotice } from "@/lib/authSession";
import { decideAfterResolve, isSubmittedStatus, newClientSubmissionId, shouldRunSubmit } from "@/lib/submitAttemptReuse";
import { friendlySubmitFailureMessage } from "@/lib/submitFailureMessages";

/** The server model: identity by (org,user,logical id); the auth layer 403s while the session is dead. */
function server() {
  const rows = new Map<string, { id: string; status: string }>();
  let auth: "ok" | "revoked" = "ok";
  let seq = 0;
  const audit: string[] = [];
  const authError = { name: "AuthApiError", status: 403, code: "session_not_found", message: "Session from session_id claim in JWT does not exist" };
  const resolve = async (key: string) => {
    if (auth === "revoked") throw authError;
    if (!rows.has(key)) {
      const id = `exp-${++seq}`;
      rows.set(key, { id, status: "draft" });
      audit.push("expense_created");
    }
    return { id: rows.get(key)!.id, status: rows.get(key)!.status };
  };
  const submit = async (key: string) => {
    if (auth === "revoked") throw authError;
    rows.get(key)!.status = "submitted";
    audit.push("expense_submitted");
  };
  return { rows, audit, setAuth: (a: "ok" | "revoked") => (auth = a), resolve, submit };
}

async function press(srv: ReturnType<typeof server>, csid: string, user = "u1") {
  const key = `${user}|${csid}`;
  const r = await srv.resolve(key);
  if (decideAfterResolve({ status: r.status }) === "proceed" && shouldRunSubmit(r.status)) await srv.submit(key);
  if (!isSubmittedStatus(srv.rows.get(key)!.status)) throw new Error("still a draft");
  return r;
}

beforeEach(() => {
  signOut.mockClear();
  resetSessionExpiredNotice();
});

describe("auth failure between draft creation and submit", () => {
  it("session revoked after the draft exists -> one clean recovery -> sign in again -> retry = same row, one submit, one audit trail", async () => {
    const srv = server();
    const csid = newClientSubmissionId(); // persisted with the recoverable form, survives the sign-in round trip

    // first press: the draft is created, then the session dies before the submit lands
    await srv.resolve(`u1|${csid}`);
    srv.setAuth("revoked");
    let failure: unknown;
    try { await press(srv, csid); } catch (e) { failure = e; }
    expect(failure).toMatchObject({ code: "session_not_found" });

    // the app recovers exactly once, however many in-flight calls hit the 403
    await Promise.all([recoverFromInvalidAuthSession(failure as never), recoverFromInvalidAuthSession(failure as never), recoverFromInvalidAuthSession(failure as never)]);
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });

    // the user is told what happened and that nothing was lost
    expect(friendlySubmitFailureMessage(failure, { draftPreserved: true })).toMatch(/sign in again.*preserved/i);

    // user signs in again and presses Submit with the restored form (same logical id)
    srv.setAuth("ok");
    await press(srv, csid);
    expect([...srv.rows.values()]).toHaveLength(1);
    expect([...srv.rows.values()][0].status).toBe("submitted");
    expect(srv.audit).toEqual(["expense_created", "expense_submitted"]); // no duplicate draft, no second submit
  });

  it("the session dies and a retry happens BEFORE re-auth: still no second row, and the error is explicit (not silent)", async () => {
    const srv = server();
    const csid = newClientSubmissionId();
    await srv.resolve(`u1|${csid}`);
    srv.setAuth("revoked");
    await expect(press(srv, csid)).rejects.toMatchObject({ code: "session_not_found" });
    await expect(press(srv, csid)).rejects.toMatchObject({ code: "session_not_found" });
    srv.setAuth("ok");
    await press(srv, csid);
    expect(srv.rows.size).toBe(1);
  });

  it("a different user signing in on the same browser cannot reuse the first user's row", async () => {
    const srv = server();
    const csid = newClientSubmissionId();
    await press(srv, csid, "u1");
    await press(srv, csid, "u2");
    expect(srv.rows.size).toBe(2);
  });
});
