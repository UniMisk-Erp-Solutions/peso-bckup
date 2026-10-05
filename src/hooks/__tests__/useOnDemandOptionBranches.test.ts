/**
 * INCIDENT hotfix (2026-09) regression coverage for useOnDemandOptionBranches
 * itself, in isolation from CategoryFormFieldsSection / ExpenseForm.
 *
 * These tests exist because the pre-fix hook exposed only a bare
 * isLoading/hasError boolean pair and inferred "resolved" from
 * `optionBranches.length > 0` — indistinguishable from "this template
 * genuinely has zero conditional fields" — and had no per-template
 * generation guard, so a slow-resolving fetch for an option the user had
 * already navigated away from could clobber a newer, already-resolved
 * selection. Every test below controls its own deferred Promise so the
 * fetch's resolution order is asserted explicitly rather than relied upon.
 */
import { renderHook, waitFor, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useOnDemandOptionBranches } from "../useOnDemandOptionBranches";

const rpcSpy = vi.fn();
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { rpc: (...args: unknown[]) => rpcSpy(...args) },
}));

const TEMPLATE_ID = "tmpl-project-uid";
const ORG_ID = "org-1";

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function branchRow(optionValue: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `branch-${optionValue}`,
    parent_option_value: optionValue,
    parent_branch_id: null,
    field_key: `field_${optionValue}`,
    name: `${optionValue} detail`,
    field_type: "text",
    required: true,
    ...overrides,
  };
}

beforeEach(() => {
  rpcSpy.mockReset();
});

describe("useOnDemandOptionBranches — pending-fetch visibility", () => {
  it("reports unresolved/loading and withholds branches while the RPC is in flight", async () => {
    const d = deferred<{ data: unknown; error: unknown }>();
    rpcSpy.mockReturnValue(d.promise);

    const { result } = renderHook(() => useOnDemandOptionBranches(ORG_ID));

    // Deliberately do NOT await the returned promise here — the RPC is
    // still pending, so awaiting it would hang the test. `act` still
    // flushes the synchronous "loading" state update that happens before
    // the hook's internal `await fetchRuntimeOptionBranches(...)` yields.
    act(() => {
      void result.current.selectOptionValue(TEMPLATE_ID, "UID-A");
    });

    await waitFor(() => expect(result.current.isLoadingFor(TEMPLATE_ID, "UID-A")).toBe(true));
    expect(result.current.isResolvedFor(TEMPLATE_ID, "UID-A")).toBe(false);
    expect(result.current.hasErrorFor(TEMPLATE_ID, "UID-A")).toBe(false);
    expect(result.current.optionBranches.some((b) => b.parent_option_value === "UID-A")).toBe(false);

    // Clean up the in-flight promise so it doesn't leak into later tests.
    await act(async () => {
      d.resolve({ data: { branches: [] }, error: null });
      await d.promise;
    });
  });

  it("becomes resolved with the fetched branches once the RPC resolves", async () => {
    const d = deferred<{ data: unknown; error: unknown }>();
    rpcSpy.mockReturnValue(d.promise);

    const { result } = renderHook(() => useOnDemandOptionBranches(ORG_ID));

    act(() => {
      void result.current.selectOptionValue(TEMPLATE_ID, "UID-A");
    });
    await waitFor(() => expect(result.current.isLoadingFor(TEMPLATE_ID, "UID-A")).toBe(true));
    expect(result.current.isResolvedFor(TEMPLATE_ID, "UID-A")).toBe(false);

    await act(async () => {
      d.resolve({ data: { branches: [branchRow("UID-A")] }, error: null });
      await d.promise;
    });

    await waitFor(() => expect(result.current.isResolvedFor(TEMPLATE_ID, "UID-A")).toBe(true));
    expect(result.current.isLoadingFor(TEMPLATE_ID, "UID-A")).toBe(false);
    expect(result.current.optionBranches).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "branch-UID-A", parent_option_value: "UID-A" })]),
    );
  });
});

describe("useOnDemandOptionBranches — latest-selection-wins", () => {
  it("discards a stale late-arriving response for a superseded selection on the same template", async () => {
    const deferredA = deferred<{ data: unknown; error: unknown }>();
    const deferredB = deferred<{ data: unknown; error: unknown }>();

    rpcSpy.mockImplementation((_fn: string, args: Record<string, unknown>) => {
      const value = args.p_parent_option_value as string;
      if (value === "UID-A") return deferredA.promise;
      if (value === "UID-B") return deferredB.promise;
      throw new Error(`unexpected option value ${value}`);
    });

    const { result } = renderHook(() => useOnDemandOptionBranches(ORG_ID));

    // Select UID-A first (fetch A starts, left pending). Do not await — the
    // deferred promise never resolves on its own.
    act(() => {
      void result.current.selectOptionValue(TEMPLATE_ID, "UID-A");
    });
    await waitFor(() => expect(result.current.isLoadingFor(TEMPLATE_ID, "UID-A")).toBe(true));

    // User changes their mind before A resolves: select UID-B on the SAME
    // template (fetch B starts, also left pending).
    act(() => {
      void result.current.selectOptionValue(TEMPLATE_ID, "UID-B");
    });
    await waitFor(() => expect(result.current.isLoadingFor(TEMPLATE_ID, "UID-B")).toBe(true));

    // B resolves first.
    await act(async () => {
      deferredB.resolve({ data: { branches: [branchRow("UID-B")] }, error: null });
      await deferredB.promise;
    });
    await waitFor(() => expect(result.current.isResolvedFor(TEMPLATE_ID, "UID-B")).toBe(true));

    // A resolves LAST, after B has already landed — this is the exact
    // ordering that used to clobber the newer selection.
    await act(async () => {
      deferredA.resolve({ data: { branches: [branchRow("UID-A")] }, error: null });
      await deferredA.promise;
    });

    // Give any (incorrect) state update from A's resolution a chance to land
    // before asserting it didn't.
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.statusByTemplate[TEMPLATE_ID]).toEqual({ state: "ready", forValue: "UID-B" });
    expect(result.current.isResolvedFor(TEMPLATE_ID, "UID-B")).toBe(true);
    expect(result.current.isResolvedFor(TEMPLATE_ID, "UID-A")).toBe(false);
    expect(result.current.optionBranches.some((b) => b.parent_option_value === "UID-A")).toBe(false);
    expect(result.current.optionBranches.some((b) => b.parent_option_value === "UID-B")).toBe(true);
  });
});

describe("useOnDemandOptionBranches — failed fetch", () => {
  it("sets hasErrorFor and keeps isResolvedFor false when the RPC returns an error", async () => {
    rpcSpy.mockResolvedValue({ data: null, error: { message: "boom" } });

    const { result } = renderHook(() => useOnDemandOptionBranches(ORG_ID));

    await act(async () => {
      await result.current.selectOptionValue(TEMPLATE_ID, "UID-A");
    });

    await waitFor(() => expect(result.current.hasErrorFor(TEMPLATE_ID, "UID-A")).toBe(true));
    expect(result.current.isResolvedFor(TEMPLATE_ID, "UID-A")).toBe(false);
    expect(result.current.isLoadingFor(TEMPLATE_ID, "UID-A")).toBe(false);
    expect(result.current.optionBranches.some((b) => b.parent_option_value === "UID-A")).toBe(false);
  });
});

describe("useOnDemandOptionBranches — caching", () => {
  it("does not re-issue the RPC when the same (templateId, value) is selected again", async () => {
    rpcSpy.mockResolvedValue({ data: { branches: [branchRow("UID-A")] }, error: null });

    const { result } = renderHook(() => useOnDemandOptionBranches(ORG_ID));

    await act(async () => {
      await result.current.selectOptionValue(TEMPLATE_ID, "UID-A");
    });
    await waitFor(() => expect(result.current.isResolvedFor(TEMPLATE_ID, "UID-A")).toBe(true));
    expect(rpcSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.selectOptionValue(TEMPLATE_ID, "UID-A");
    });

    expect(rpcSpy).toHaveBeenCalledTimes(1);
    expect(result.current.isResolvedFor(TEMPLATE_ID, "UID-A")).toBe(true);
  });
});
