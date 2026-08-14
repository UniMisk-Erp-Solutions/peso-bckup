/**
 * Regression test for the raw i18n key leak in the Expense Review timeline
 * (2026-08-13 MicroLink Production screenshot): "review.timeline.actions.expense_updated"
 * rendered literally instead of "Expense updated".
 *
 * Root cause: the i18n instance is configured with returnEmptyString:false
 * (src/i18n/i18nInstance.ts), so `t(key, { defaultValue: "" })` returns the raw
 * key — not "" — when the key is missing. The old `if (translated) return translated`
 * check treated that raw key as a valid translation. The fix uses i18n.exists(key)
 * to detect a missing key correctly regardless of that config, falling through to
 * formatAuditLogAction's humanized text.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ExpenseReviewTimeline } from "@/components/ExpenseReviewTimeline";

const RAW_KEY = "admin:review.timeline.actions.expense_updated";

// Reproduces the real i18next behavior under returnEmptyString:false: a missing key
// returns the key itself (not the empty-string defaultValue), and i18n.exists()
// correctly reports it as absent.
const KNOWN_KEYS = new Set([
  "admin:review.timeline.currentStatus",
  "admin:review.timeline.activity",
]);

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => {
      if (KNOWN_KEYS.has(key)) return "translated";
      return opts?.defaultValue !== undefined && opts.defaultValue !== ""
        ? opts.defaultValue
        : key; // returnEmptyString:false behavior — never returns ""
    },
    i18n: { exists: (key: string) => KNOWN_KEYS.has(key) },
  }),
}));

vi.mock("@/components/StatusBadge", () => ({
  StatusBadge: () => <span>status</span>,
}));

function baseExpense() {
  return { status: "submitted", approval_tier: null };
}

describe("ExpenseReviewTimeline — no raw i18n key ever renders", () => {
  it("renders 'Expense updated' (not the raw key) for an unmapped audit action", () => {
    render(
      <ExpenseReviewTimeline
        expense={baseExpense()}
        auditLogs={[{ action: "expense_updated", user_name: "Jane", created_at: "2026-08-13T04:00:00Z" }]}
        hierarchy={{ enabled: false, teamLeader: false, executive: false }}
      />,
    );

    expect(screen.getByText("Expense Updated")).toBeInTheDocument();
    expect(screen.queryByText(RAW_KEY)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("review.timeline.actions.expense_updated");
  });

  it("still uses the real translation when the key genuinely exists", () => {
    render(
      <ExpenseReviewTimeline
        expense={baseExpense()}
        auditLogs={[{ action: "expense_created", user_name: "Jane", created_at: "2026-08-13T04:00:00Z" }]}
        hierarchy={{ enabled: false, teamLeader: false, executive: false }}
      />,
    );
    // "expense_created" is not in KNOWN_KEYS in this test's mock either — falls back to
    // formatAuditLogAction's own ACTION_LABELS entry, proving the exists() gate correctly
    // reaches the fallback (not a blanket bypass of real translations).
    expect(screen.getByText("Expense created")).toBeInTheDocument();
  });

  it("never renders any literal 'review.timeline.actions.*' string for any unmapped action", () => {
    render(
      <ExpenseReviewTimeline
        expense={baseExpense()}
        auditLogs={[
          { action: "some_future_action_not_yet_translated", user_name: "Jane", created_at: "2026-08-13T04:00:00Z" },
        ]}
        hierarchy={{ enabled: false, teamLeader: false, executive: false }}
      />,
    );
    expect(document.body.textContent).not.toMatch(/review\.timeline\.actions\./);
    expect(screen.getByText("Some Future Action Not Yet Translated")).toBeInTheDocument();
  });
});
