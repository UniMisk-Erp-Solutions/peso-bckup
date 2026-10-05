import { useState } from "react";
import { Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { ProductPreviewShell } from "./ProductPreviewShell";
import { DEMO_TEAMS } from "./demoData";

/** My Teams: a lead sees only their own team's members. Local state only. */
export function InteractiveTeamPreview({ className }: { className?: string }) {
  const [teamId, setTeamId] = useState(DEMO_TEAMS[0].id);
  const team = DEMO_TEAMS.find((t) => t.id === teamId) ?? DEMO_TEAMS[0];
  const pending = team.members.reduce((n, m) => n + m.pending, 0);
  const approved = team.members.reduce((n, m) => n + m.approved, 0);

  return (
    <ProductPreviewShell title="My Teams" className={className}>
      <div role="tablist" aria-label="Teams" className="flex flex-wrap gap-2">
        {DEMO_TEAMS.map((t) => (
          <button
            key={t.id}
            id={`demo-team-tab-${t.id}`}
            role="tab"
            type="button"
            aria-selected={t.id === teamId}
            aria-controls="demo-team-panel"
            onClick={() => setTeamId(t.id)}
            className={cn(
              "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              t.id === teamId ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background text-muted-foreground hover:bg-muted",
            )}
          >
            {t.name}
          </button>
        ))}
      </div>
      <div id="demo-team-panel" role="tabpanel" aria-labelledby={`demo-team-tab-${team.id}`} className="mt-4">
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-xl border border-border bg-muted/30 p-3">
            <p className="text-[11px] text-muted-foreground">Pending review</p>
            <p className="text-xl font-bold tabular-nums text-foreground" data-testid="demo-team-pending">
              {pending}
            </p>
          </div>
          <div className="rounded-xl border border-border bg-muted/30 p-3">
            <p className="text-[11px] text-muted-foreground">Approved</p>
            <p className="text-xl font-bold tabular-nums text-foreground" data-testid="demo-team-approved">
              {approved}
            </p>
          </div>
        </div>
        <ul className="mt-3 space-y-1.5">
          {team.members.map((m) => (
            <li key={m.name} className="flex items-center gap-2.5 rounded-lg border border-border bg-background px-3 py-2">
              <Users className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-sm text-foreground">{m.name}</span>
              <span className="text-xs text-warning">{m.pending} pending</span>
              <span className="text-xs text-muted-foreground">{m.approved} approved</span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-muted-foreground">Team leads see their own members, not the whole organization.</p>
      </div>
    </ProductPreviewShell>
  );
}
