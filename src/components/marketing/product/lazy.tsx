import { lazy, Suspense, type ComponentType } from "react";

/**
 * Lazy wrappers for the interactive previews so below-the-fold demos never
 * weigh on first paint. Each preview is a separate chunk.
 */
export const LazyInteractiveDashboardPreview = lazy(() =>
  import("./InteractiveDashboardPreview").then((m) => ({ default: m.InteractiveDashboardPreview })),
);
export const LazyInteractiveExpenseFormPreview = lazy(() =>
  import("./InteractiveExpenseFormPreview").then((m) => ({ default: m.InteractiveExpenseFormPreview })),
);
export const LazyInteractiveApprovalWorkflow = lazy(() =>
  import("./InteractiveApprovalWorkflow").then((m) => ({ default: m.InteractiveApprovalWorkflow })),
);
export const LazyInteractiveReportPreview = lazy(() =>
  import("./InteractiveReportPreview").then((m) => ({ default: m.InteractiveReportPreview })),
);
export const LazyInteractiveBalanceTransfer = lazy(() =>
  import("./InteractiveBalanceTransfer").then((m) => ({ default: m.InteractiveBalanceTransfer })),
);
export const LazyInteractiveTeamPreview = lazy(() =>
  import("./InteractiveTeamPreview").then((m) => ({ default: m.InteractiveTeamPreview })),
);
export const LazyInteractiveHowItWorksTour = lazy(() =>
  import("./InteractiveHowItWorksTour").then((m) => ({ default: m.InteractiveHowItWorksTour })),
);

export function DemoFallback({ minHeight = 320 }: { minHeight?: number }) {
  return (
    <div
      className="w-full rounded-2xl border border-border bg-muted/40 motion-safe:animate-pulse"
      style={{ minHeight }}
      aria-hidden
    />
  );
}

/** Wraps any lazy preview in a Suspense boundary with a same-size placeholder. */
export function LazyDemo({ children, minHeight }: { children: React.ReactNode; minHeight?: number }) {
  return <Suspense fallback={<DemoFallback minHeight={minHeight} />}>{children}</Suspense>;
}

export type { ComponentType };
