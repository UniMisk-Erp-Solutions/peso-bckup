import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface ProductPreviewShellProps {
  title: string;
  children: ReactNode;
  className?: string;
  /** Small caption under the frame, e.g. "Recent values are personal to each employee." */
  caption?: string;
}

/**
 * Common frame for the interactive product previews: a lightweight window
 * that says "Interactive preview" so nobody mistakes the fictional numbers for
 * their own account. Purely presentational.
 */
export function ProductPreviewShell({ title, children, className, caption }: ProductPreviewShellProps) {
  return (
    <figure className={cn("w-full", className)}>
      <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-soft">
        <div className="flex items-center justify-between gap-2 border-b border-border bg-muted/40 px-4 py-2.5">
          <span className="truncate text-xs font-medium text-muted-foreground">{title}</span>
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
            <span className="h-1.5 w-1.5 rounded-full bg-primary" aria-hidden />
            Interactive preview
          </span>
        </div>
        <div className="p-4 sm:p-5">{children}</div>
      </div>
      {caption ? <figcaption className="mt-2 text-center text-xs text-muted-foreground">{caption}</figcaption> : null}
    </figure>
  );
}
