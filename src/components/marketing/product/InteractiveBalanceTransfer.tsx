import { useState } from "react";
import { ArrowRight, Clock, CheckCircle, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { ProductPreviewShell } from "./ProductPreviewShell";
import { ADMIN_START_BALANCE, TRANSFER_AMOUNTS, TRANSFER_RECIPIENTS, formatDemoINR } from "./demoData";

type Phase = "form" | "awaiting" | "accepted" | "rejected";

const selectClass =
  "flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/**
 * Transfer offers: the sender proposes, the recipient accepts or rejects, and
 * only an accepted offer moves balances. Local state only.
 */
export function InteractiveBalanceTransfer({ className }: { className?: string }) {
  const [phase, setPhase] = useState<Phase>("form");
  const [recipientName, setRecipientName] = useState(TRANSFER_RECIPIENTS[0].name);
  const [amount, setAmount] = useState(TRANSFER_AMOUNTS[1]);

  const recipient = TRANSFER_RECIPIENTS.find((r) => r.name === recipientName) ?? TRANSFER_RECIPIENTS[0];
  const accepted = phase === "accepted";
  const adminBalance = accepted ? ADMIN_START_BALANCE - amount : ADMIN_START_BALANCE;
  const recipientBalance = accepted ? recipient.balance + amount : recipient.balance;

  return (
    <ProductPreviewShell title="Balance transfer" className={className}>
      <div className="grid gap-3 sm:grid-cols-[1fr_auto_1fr] sm:items-center">
        <div className="rounded-xl border border-border bg-muted/30 p-3">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">From</p>
          <p className="text-xs font-medium text-foreground">Admin</p>
          <p className="text-lg font-bold tabular-nums text-foreground" data-testid="demo-admin-balance">
            {formatDemoINR(adminBalance)}
          </p>
        </div>
        <div className="flex items-center justify-center gap-1.5 text-primary sm:flex-col">
          <ArrowRight className="h-5 w-5 rotate-90 sm:rotate-0" aria-hidden />
          <span className="text-xs font-semibold tabular-nums">{formatDemoINR(amount)}</span>
        </div>
        <div className="rounded-xl border border-border bg-muted/30 p-3">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">To</p>
          <p className="truncate text-xs font-medium text-foreground">{recipient.name}</p>
          <p className="text-lg font-bold tabular-nums text-foreground" data-testid="demo-recipient-balance">
            {formatDemoINR(recipientBalance)}
          </p>
        </div>
      </div>

      {phase === "form" && (
        <div className="mt-4 space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="demo-transfer-to" className="text-xs text-muted-foreground">
                Send to
              </Label>
              <select id="demo-transfer-to" className={selectClass} value={recipientName} onChange={(e) => setRecipientName(e.target.value)}>
                {TRANSFER_RECIPIENTS.map((r) => (
                  <option key={r.name}>{r.name}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="demo-transfer-amount" className="text-xs text-muted-foreground">
                Amount
              </Label>
              <select id="demo-transfer-amount" className={selectClass} value={amount} onChange={(e) => setAmount(Number(e.target.value))}>
                {TRANSFER_AMOUNTS.map((a) => (
                  <option key={a} value={a}>
                    {formatDemoINR(a)}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <Button size="sm" className="w-full" onClick={() => setPhase("awaiting")}>
            Send transfer
          </Button>
        </div>
      )}

      {phase === "awaiting" && (
        <div className="mt-4 space-y-3" role="status">
          <div className="flex items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning">
            <Clock className="h-4 w-4 shrink-0" aria-hidden />
            <span>Awaiting acceptance from {recipient.name}</span>
          </div>
          <p className="text-xs text-muted-foreground">Balances change only when the recipient accepts. Try their side:</p>
          <div className="flex gap-2">
            <Button size="sm" className="flex-1" onClick={() => setPhase("accepted")}>
              Accept
            </Button>
            <Button size="sm" variant="outline" className="flex-1" onClick={() => setPhase("rejected")}>
              Reject
            </Button>
          </div>
        </div>
      )}

      {(phase === "accepted" || phase === "rejected") && (
        <div className="mt-4 space-y-3" role="status">
          <div
            className={
              accepted
                ? "flex items-center gap-2 rounded-lg border border-success/40 bg-success/10 px-3 py-2 text-sm text-success"
                : "flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground"
            }
          >
            {accepted ? <CheckCircle className="h-4 w-4 shrink-0" aria-hidden /> : <XCircle className="h-4 w-4 shrink-0" aria-hidden />}
            <span>{accepted ? `Accepted. ${formatDemoINR(amount)} moved to ${recipient.name}.` : "Rejected. No balances changed."}</span>
          </div>
          <Button size="sm" variant="outline" className="w-full" onClick={() => setPhase("form")}>
            Try another transfer
          </Button>
        </div>
      )}
    </ProductPreviewShell>
  );
}
