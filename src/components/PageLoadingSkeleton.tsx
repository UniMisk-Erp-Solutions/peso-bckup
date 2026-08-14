export function PageLoadingSkeleton() {
  return (
    <div className="flex min-h-[40vh] items-center justify-center p-8">
      <div className="text-center text-muted-foreground">
        <div className="mx-auto mb-3 h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        <p className="text-sm">Loading…</p>
      </div>
    </div>
  );
}
