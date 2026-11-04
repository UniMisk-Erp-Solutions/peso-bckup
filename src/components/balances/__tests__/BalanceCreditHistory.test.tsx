import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const ledger = [
  { id: "1", user_id: "u1", amount_delta: 500, balance_after: 500, entry_type: "balance_credit", source_type: "admin_credit_v3", actor_user_id: "a1", effective_at: "2026-10-16T18:29:59Z", created_at: "2026-10-17T05:00:00Z", note: "advance", idempotency_key: null },
  { id: "2", user_id: "u1", amount_delta: 700, balance_after: 1200, entry_type: "balance_credit", source_type: "import_batch_v3", actor_user_id: "a1", effective_at: "2026-10-16T18:29:59Z", created_at: "2026-10-17T06:00:00Z", note: "Tally voucher 7", idempotency_key: "tally:Demo:G1:Amit-1001" },
  { id: "3", user_id: "u1", amount_delta: 100, balance_after: 1300, entry_type: "opening_credit", source_type: "import_batch_v3", actor_user_id: "a1", effective_at: "2026-10-01T00:00:00Z", created_at: "2026-10-17T07:00:00Z", note: null, idempotency_key: "file:abc" },
];

vi.mock("@/integrations/supabase/client", () => {
  const q: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "order"]) q[m] = () => q;
  q.limit = async () => ({ data: ledger, error: null });
  return { supabase: { from: () => q } };
});
vi.mock("@/lib/supabaseInQuery", () => ({
  fetchProfileNamesByUserIds: async () => new Map([["u1", "Amit Test"], ["a1", "MicroLink Admin"]]),
}));

import { BalanceCreditHistory, creditOrigin } from "../BalanceCreditHistory";

describe("creditOrigin", () => {
  it("separates manual, Tally, import and reversal", () => {
    expect(creditOrigin({ entry_type: "balance_credit", source_type: "admin_credit_v3", idempotency_key: null })).toBe("manual");
    expect(creditOrigin({ entry_type: "balance_credit", source_type: "import_batch_v3", idempotency_key: "tally:C:G:L" })).toBe("tally");
    expect(creditOrigin({ entry_type: "opening_credit", source_type: "import_batch_v3", idempotency_key: "x" })).toBe("import");
    expect(creditOrigin({ entry_type: "credit_reversal", source_type: "import_batch_v3", idempotency_key: null })).toBe("reversal");
  });
});

describe("BalanceCreditHistory", () => {
  it("lists manual and Tally credits with their source and filters by it", async () => {
    render(<BalanceCreditHistory organizationId="o" />);
    await waitFor(() => expect(screen.getAllByTestId("credit-history-row")).toHaveLength(3));
    const origins = screen.getAllByTestId("credit-history-row").map((r) => r.getAttribute("data-origin"));
    expect(origins).toEqual(["manual", "tally", "import"]);
    expect(screen.getAllByText("Amit Test").length).toBe(3);
    fireEvent.change(screen.getByPlaceholderText(/Search by employee/), { target: { value: "voucher 7" } });
    expect(screen.getAllByTestId("credit-history-row")).toHaveLength(1);
    expect(screen.getByText("Tally sync")).toBeTruthy();
  });
});
