/**
 * Proves the real Calendar control (not just the pure predicate) actually
 * blocks clicking a locked date and allows everything outside the range --
 * wired exactly the way ExpenseForm.tsx / ExpenseBatchForm.tsx wire it:
 * `disabled={(date) => isExpenseDateLocked(date, locks).locked}`.
 *
 * Matrix required by the 2026-10-01 fail-closed review: for an active lock
 * 2026-08-01 -> 2026-08-31, 2026-07-31 is selectable, 2026-08-01/08-05/08-31
 * are all blocked, and 2026-09-01 is selectable again.
 */
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Calendar } from "@/components/ui/calendar";
import { isExpenseDateLocked, type ExpenseDateLock } from "@/lib/expenseDateLocks";

const AUGUST_LOCK: ExpenseDateLock[] = [
  {
    id: "lock-1",
    organization_id: "org-a",
    date_from: "2026-08-01",
    date_to: "2026-08-31",
    reason: "Monthly accounts closed",
    is_active: true,
    created_by: "admin-1",
    created_at: "2026-07-25T00:00:00Z",
    updated_at: "2026-07-25T00:00:00Z",
  },
];

/** Finds the one enabled day-button in the currently-rendered grid whose
 *  accessible day-of-month text matches, excluding the OTHER month's
 *  same-numbered outside day by scoping on the `day-outside` class. */
function findDayButton(container: HTMLElement, dayOfMonth: number, { outside }: { outside: boolean }) {
  const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('button[name="day"]'));
  const matches = buttons.filter((b) => b.textContent?.trim() === String(dayOfMonth));
  const scoped = matches.filter((b) => {
    const isOutside = b.classList.contains("day-outside");
    return outside ? isOutside : !isOutside;
  });
  expect(scoped.length, `expected exactly one ${outside ? "outside" : "in-month"} day button for ${dayOfMonth}`).toBe(1);
  return scoped[0];
}

describe("Calendar + isExpenseDateLocked wiring (real DOM, not just the predicate)", () => {
  it("blocks clicking every date inside the active lock range, allows the boundary days outside it", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();

    const { container } = render(
      <Calendar
        mode="single"
        selected={undefined}
        onSelect={onSelect}
        month={new Date(2026, 7, 1)} // August 2026 (0-indexed month)
        disabled={(date) => isExpenseDateLocked(date, AUGUST_LOCK).locked}
      />,
    );

    // 2026-08-01, 2026-08-05 (middle), 2026-08-31 (date_to) -- in-month, must be disabled/blocked.
    for (const day of [1, 5, 31]) {
      const btn = findDayButton(container, day, { outside: false });
      expect(btn).toBeDisabled();
      await user.click(btn);
    }
    expect(onSelect).not.toHaveBeenCalled();

    // 2026-07-31 (day before the range) renders as an outside day in August's
    // grid and must remain selectable.
    const julyThirtyFirst = findDayButton(container, 31, { outside: true });
    expect(julyThirtyFirst).not.toBeDisabled();
    await user.click(julyThirtyFirst);
    expect(onSelect).toHaveBeenCalledTimes(1);
    const julySelected = onSelect.mock.calls[0][0] as Date;
    expect([julySelected.getFullYear(), julySelected.getMonth(), julySelected.getDate()]).toEqual([2026, 6, 31]);

    onSelect.mockClear();

    // 2026-09-01 (day after the range) likewise renders as an outside day
    // and must remain selectable.
    const septemberFirst = findDayButton(container, 1, { outside: true });
    expect(septemberFirst).not.toBeDisabled();
    await user.click(septemberFirst);
    expect(onSelect).toHaveBeenCalledTimes(1);
    const septSelected = onSelect.mock.calls[0][0] as Date;
    expect([septSelected.getFullYear(), septSelected.getMonth(), septSelected.getDate()]).toEqual([2026, 8, 1]);
  });
});

describe("Calendar `getLockedDayReason` -- hover/focus/tap explanation (2026-10-01 reason UX pass)", () => {
  it("a locked day with a reason: NOT HTML-disabled (click still reaches onSelect), carries the reason in its aria-label", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const { container } = render(
      <Calendar
        mode="single"
        selected={undefined}
        onSelect={onSelect}
        month={new Date(2026, 7, 1)}
        disabled={(date) => date > new Date(2027, 0, 1)} // unrelated rule, nothing in August is future-disabled here
        getLockedDayReason={(date) => (isExpenseDateLocked(date, AUGUST_LOCK).locked ? "Monthly accounts closed" : null)}
      />,
    );

    const aug5 = findDayButton(container, 5, { outside: false });
    expect(aug5).not.toBeDisabled();
    expect(aug5.getAttribute("aria-label")).toMatch(/august 5, 2026/i);
    expect(aug5.getAttribute("aria-label")).toContain("Monthly accounts closed");
    expect(aug5.getAttribute("title")).toBe("Monthly accounts closed");

    // The caller's onSelect is reached (it is the caller's job to refuse
    // the actual selection) -- this is what makes the mobile tap-to-explain
    // behavior possible at all, since a real disabled button never fires.
    await user.click(aug5);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("a locked day with NO reason falls back to the caller-provided fallback text", () => {
    const { container } = render(
      <Calendar
        mode="single"
        selected={undefined}
        onSelect={vi.fn()}
        month={new Date(2026, 7, 1)}
        getLockedDayReason={(date) =>
          isExpenseDateLocked(date, AUGUST_LOCK).locked ? "Expense submission has been blocked by your admin for this date." : null
        }
      />,
    );
    const aug5 = findDayButton(container, 5, { outside: false });
    expect(aug5.getAttribute("aria-label")).toContain("Expense submission has been blocked by your admin for this date.");
  });

  it("a date disabled only for an UNRELATED reason (future date) gets no lock explanation at all", () => {
    const { container } = render(
      <Calendar
        mode="single"
        selected={undefined}
        onSelect={vi.fn()}
        month={new Date(2026, 8, 1)} // September 2026 -- outside the August lock range entirely
        disabled={(date) => date > new Date(2026, 8, 10)} // "future" rule, nothing to do with locking
        getLockedDayReason={(date) => (isExpenseDateLocked(date, AUGUST_LOCK).locked ? "Monthly accounts closed" : null)}
      />,
    );
    // Sept 20 is disabled by the unrelated future-date rule, and is OUTSIDE
    // the August lock range -- it must be genuinely disabled and must NOT
    // carry the lock explanation/aria-label suffix.
    const sept20 = findDayButton(container, 20, { outside: false });
    expect(sept20).toBeDisabled();
    expect(sept20.getAttribute("aria-label") ?? "").not.toContain("Monthly accounts closed");
    expect(sept20.getAttribute("title")).toBeNull();
  });
});
