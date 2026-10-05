/**
 * BaseExpenseFieldInput -- memory render-path gating (owner QA fix pass,
 * 2026-09-23).
 *
 * Before this fix, whether a memory-eligible base field (title/destination/
 * purpose) rendered through RecentValueTextInput depended on
 * `recentValues.length > 0` -- so "feature on, no history seeded yet" and
 * "feature off" were indistinguishable render paths, both silently falling
 * back to a plain input. These tests pin the fix: the render path is decided
 * by `memoryEnabled` + field eligibility ALONE.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { BaseExpenseFieldInput } from "@/components/BaseExpenseFieldInput";
import { DEFAULT_BASE_FIELD_CONFIG } from "@/lib/expenseFormConfig";

describe("BaseExpenseFieldInput -- memory gating", () => {
  it("renders through RecentValueTextInput when memoryEnabled is true, even with zero recent values (no seed data yet)", () => {
    render(
      <BaseExpenseFieldInput
        config={DEFAULT_BASE_FIELD_CONFIG.destination}
        value=""
        onChange={vi.fn()}
        featureEnabled={false}
        memoryEnabled={true}
        recentValues={[]}
        defaultControl={<input data-testid="plain-fallback" />}
      />,
    );
    // Free typing must still work identically either way -- this proves the
    // component took the RecentValueTextInput path (autoComplete="off" +
    // a generated "pw-recent-" name is that component's own signature, kept
    // even with zero suggestions -- role stays a plain textbox until there
    // is at least one real suggestion, see RecentValueTextInput.test.tsx).
    const input = screen.getByRole("textbox");
    expect(input).toHaveAttribute("autocomplete", "off");
    expect(input.getAttribute("name")).toMatch(/^pw-recent-/);
    expect(screen.queryByTestId("plain-fallback")).not.toBeInTheDocument();
  });

  it("renders the same input whether recentValues is [] or undefined, when memoryEnabled is true (no crash, no behavior difference)", () => {
    const { unmount } = render(
      <BaseExpenseFieldInput
        config={DEFAULT_BASE_FIELD_CONFIG.destination}
        value=""
        onChange={vi.fn()}
        featureEnabled={false}
        memoryEnabled={true}
        defaultControl={<input data-testid="plain-fallback" />}
      />,
    );
    expect(screen.getByRole("textbox")).toHaveAttribute("autocomplete", "off");
    unmount();
  });

  it("falls back to defaultControl when memoryEnabled is false, regardless of stale recentValues", () => {
    render(
      <BaseExpenseFieldInput
        config={DEFAULT_BASE_FIELD_CONFIG.destination}
        value=""
        onChange={vi.fn()}
        featureEnabled={false}
        memoryEnabled={false}
        recentValues={["Ahmedabad Office"]}
        defaultControl={<input data-testid="plain-fallback" />}
      />,
    );
    expect(screen.getByTestId("plain-fallback")).toBeInTheDocument();
  });

  it("never renders memory suggestions for a field that is not memory-eligible (e.g. category), even with memoryEnabled true", () => {
    render(
      <BaseExpenseFieldInput
        config={DEFAULT_BASE_FIELD_CONFIG.category}
        value=""
        onChange={vi.fn()}
        featureEnabled={false}
        memoryEnabled={true}
        recentValues={["Travel"]}
        defaultControl={<input data-testid="plain-fallback" />}
      />,
    );
    expect(screen.getByTestId("plain-fallback")).toBeInTheDocument();
  });

  it("a seeded suggestion actually appears once memoryEnabled is true and data has arrived", () => {
    render(
      <BaseExpenseFieldInput
        config={DEFAULT_BASE_FIELD_CONFIG.destination}
        value=""
        onChange={vi.fn()}
        featureEnabled={false}
        memoryEnabled={true}
        recentValues={["Ahmedabad Office"]}
        defaultControl={<input />}
      />,
    );
    fireEvent.focus(screen.getByRole("combobox"));
    expect(screen.getByText("Ahmedabad Office")).toBeInTheDocument();
  });

  it("defaults memoryEnabled to false when the prop is omitted (backward compatible for any caller not yet updated)", () => {
    render(
      <BaseExpenseFieldInput
        config={DEFAULT_BASE_FIELD_CONFIG.destination}
        value=""
        onChange={vi.fn()}
        featureEnabled={false}
        recentValues={["Ahmedabad Office"]}
        defaultControl={<input data-testid="plain-fallback" />}
      />,
    );
    expect(screen.getByTestId("plain-fallback")).toBeInTheDocument();
  });
});
