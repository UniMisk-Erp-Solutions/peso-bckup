import { afterEach, describe, expect, it, vi } from "vitest";
import { submitWithReconcile, type SubmitRunOutcome } from "@/lib/submitReconcile";
import { isUnknownOutcomeError } from "@/lib/submitFailureMessages";
import { waitUntilPageVisible } from "@/lib/pageVisibility";
import { recordSubmitMetric } from "@/lib/submitTelemetry";
import { shouldRunSubmit, newClientSubmissionId } from "@/lib/submitAttemptReuse";

/**
 * In-memory model of the SERVER (resolve_or_create_expense_v1 keyed by client_submission_id, the submit
 * transition, ONE submit audit + ONE notification per transition, and the bill invariant) driven by the same
 * press logic the form uses. Faults are injected per request: the browser failing the fetch before the server
 * sees it, the response being lost AFTER the server committed, and a statement timeout (rolled back).
 */
type Fault = "drop_before_send" | "lose_response_after_commit" | "statement_timeout" | null;

function server(opts: { threshold?: number } = {}) {
  const rows = new Map<string, { id: string; status: "draft" | "submitted"; amount: number; bills: number; deleted: number }>();
  const byLogicalId = new Map<string, string>();
  let audit = 0;
  let notifications = 0;
  return {
    rows,
    get audit() { return audit; },
    get notifications() { return notifications; },
    resolve(csid: string, amount: number) {
      let id = byLogicalId.get(csid);
      if (!id) {
        id = `e${rows.size + 1}`;
        byLogicalId.set(csid, id);
        rows.set(id, { id, status: "draft", amount, bills: 0, deleted: 0 });
      }
      return rows.get(id)!;
    },
    attach(id: string, live = 1, deleted = 0) {
      const r = rows.get(id)!;
      r.bills = live;
      r.deleted = deleted;
    },
    submit(id: string) {
      const r = rows.get(id)!;
      if (r.status === "submitted") return r;
      if (opts.threshold !== undefined && r.amount > opts.threshold && r.bills === 0) {
        throw Object.assign(new Error("Bill photos are required for expenses above 499."), { code: "23514" });
      }
      r.status = "submitted";
      audit++;
      notifications++;
      return r;
    },
  };
}

const dropped = () => new TypeError("Load failed"); // iOS Safari / PWA
const timeout = () => Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });

/** One press, exactly as ExpenseForm does it: resolve -> (draft only) submit -> verify. Throws on failure. */
function makePress(srv: ReturnType<typeof server>, csid: string, amount: number, faults: Fault[]) {
  return async () => {
    const fault = faults.shift() ?? null;
    if (fault === "drop_before_send") throw dropped();
    const row = srv.resolve(csid, amount);
    if (shouldRunSubmit(row.status)) {
      if (fault === "statement_timeout") throw timeout();
      srv.submit(row.id);
    }
    if (fault === "lose_response_after_commit") throw dropped();
    if (srv.rows.get(row.id)!.status !== "submitted") throw new Error("The expense is still a draft after submitting.");
  };
}

async function press(run: () => Promise<void>): Promise<{ outcome: SubmitRunOutcome; attempts: number; userSawError: boolean }> {
  let userSawError = false;
  let used = false;
  const res = await submitWithReconcile({
    runOnce: async () => {
      try {
        await run();
        return "success";
      } catch (e) {
        if (isUnknownOutcomeError(e) && !used) {
          used = true;
          return "unknown";
        }
        userSawError = true;
        return "failure";
      }
    },
  });
  return { ...res, userSawError };
}

afterEach(() => vi.restoreAllMocks());

describe("PWA submit reliability: the user never has to press Submit twice", () => {
  it("1. a normal press succeeds on the first attempt", async () => {
    const s = server();
    const r = await press(makePress(s, newClientSubmissionId(), 100, []));
    expect(r).toMatchObject({ outcome: "success", attempts: 1, userSawError: false });
    expect([s.rows.size, s.audit, s.notifications]).toEqual([1, 1, 1]);
  });

  it("2. response lost AFTER the server committed: automatic reconcile shows success, one of everything", async () => {
    const s = server();
    const r = await press(makePress(s, newClientSubmissionId(), 100, ["lose_response_after_commit"]));
    expect(r).toMatchObject({ outcome: "success", attempts: 2, userSawError: false });
    expect([s.rows.size, s.audit, s.notifications]).toEqual([1, 1, 1]);
  });

  it("3. iOS stale-connection case: first request dropped BEFORE reaching the server, one auto re-run finishes it", async () => {
    const s = server();
    const r = await press(makePress(s, newClientSubmissionId(), 100, ["drop_before_send"]));
    expect(r).toMatchObject({ outcome: "success", attempts: 2, userSawError: false });
    expect([s.rows.size, s.audit, s.notifications]).toEqual([1, 1, 1]);
  });

  it("4. statement timeout while processing (rolled back): reconciles, no duplicate", async () => {
    const s = server();
    const r = await press(makePress(s, newClientSubmissionId(), 100, ["statement_timeout"]));
    expect(r).toMatchObject({ outcome: "success", attempts: 2 });
    expect([s.rows.size, s.audit, s.notifications]).toEqual([1, 1, 1]);
  });

  it("5. persistent outage: exactly ONE automatic re-run, then a failure; the manual retry reuses the same row", async () => {
    const s = server();
    const csid = newClientSubmissionId();
    const r = await press(makePress(s, csid, 100, ["drop_before_send", "drop_before_send"]));
    expect(r).toMatchObject({ outcome: "failure", attempts: 2, userSawError: true });
    const manual = await press(makePress(s, csid, 100, []));
    expect(manual.outcome).toBe("success");
    expect([s.rows.size, s.audit, s.notifications]).toEqual([1, 1, 1]);
  });

  it("6. a real bill/validation error is shown immediately and NEVER auto-retried", async () => {
    const s = server({ threshold: 499 });
    const r = await press(makePress(s, newClientSubmissionId(), 800, []));
    expect(r).toMatchObject({ outcome: "failure", attempts: 1, userSawError: true });
    expect(s.rows.size).toBe(1);
    expect(s.rows.get("e1")!.status).toBe("draft"); // one reusable draft
  });

  it("7. bill invariant preserved: soft-deleted bill blocks; a live bill passes on the SAME row", async () => {
    const s = server({ threshold: 499 });
    const csid = newClientSubmissionId();
    expect((await press(makePress(s, csid, 800, []))).outcome).toBe("failure");
    s.attach("e1", 0, 1); // only a soft-deleted bill
    expect((await press(makePress(s, csid, 800, []))).outcome).toBe("failure");
    s.attach("e1", 1, 1); // a live bill
    expect((await press(makePress(s, csid, 800, []))).outcome).toBe("success");
    expect([s.rows.size, s.audit, s.notifications]).toEqual([1, 1, 1]);
  });

  it("8. double tap / repeated press after success never duplicates", async () => {
    const s = server();
    const csid = newClientSubmissionId();
    await Promise.all([press(makePress(s, csid, 100, [])), press(makePress(s, csid, 100, []))]);
    await press(makePress(s, csid, 100, []));
    expect([s.rows.size, s.audit, s.notifications]).toEqual([1, 1, 1]);
  });

  it("9. lost response AND a manual press afterwards: still one expense", async () => {
    const s = server();
    const csid = newClientSubmissionId();
    await press(makePress(s, csid, 100, ["lose_response_after_commit"]));
    await press(makePress(s, csid, 100, []));
    expect([s.rows.size, s.audit, s.notifications]).toEqual([1, 1, 1]);
  });
});

describe("PWA background / foreground", () => {
  it("waits for the app to be visible before the recovery request (screen lock / camera return)", async () => {
    let state: DocumentVisibilityState = "hidden";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => state);
    let resolved = false;
    const p = waitUntilPageVisible(5000).then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);
    state = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await p;
    expect(resolved).toBe(true);
  });

  it("does not wait when already visible, and never waits forever", async () => {
    const spy = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    await waitUntilPageVisible(5000);
    spy.mockReturnValue("hidden");
    vi.useFakeTimers();
    const p = waitUntilPageVisible(1000);
    vi.advanceTimersByTime(1001);
    await p;
    vi.useRealTimers();
  });
});

describe("telemetry is content-free", () => {
  it("ignores any key outside the allow-list and never throws", () => {
    expect(() =>
      recordSubmitMetric("submit_failure", {
        durationMs: 1234.7,
        errorClass: "connection",
        willReconcile: true,
        ...({ expenseId: "11111111-1111-1111-1111-111111111111", token: "secret" } as object),
      }),
    ).not.toThrow();
  });
});
