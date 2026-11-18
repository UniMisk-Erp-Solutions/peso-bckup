/**
 * OrgBlockedScreen -- full-page screen shown by ProtectedRoute when Master Admin
 * has ticked the `org_blocked` flag for the user's organization (DOC-165).
 *
 * The wording is a PLACEHOLDER: the owner will supply the final message later.
 * Change ORG_BLOCKED_MESSAGE in one place (src/lib/orgBlocked.ts) when it arrives.
 */
import { useEffect, useState } from "react";
import { ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { ORG_BLOCKED_MESSAGE, ORG_BLOCKED_TITLE } from "@/lib/orgBlocked";

type Props = {
  onSignOut: () => void | Promise<void>;
};

export function OrgBlockedScreen({ onSignOut }: Props) {
  const { organizationId } = useAuth();
  const [customMessage, setCustomMessage] = useState<string | null>(null);

  // Message written by Master Admin when blocking. Best effort: if the column does not
  // exist yet or the read fails, the default placeholder message is shown.
  useEffect(() => {
    if (!organizationId) return;
    let cancelled = false;
    void (async () => {
      try {
        const { data } = await (supabase as any)
          .from("organizations")
          .select("block_message")
          .eq("id", organizationId)
          .maybeSingle();
        const msg = (data as { block_message?: string | null } | null)?.block_message;
        if (!cancelled && msg && msg.trim()) setCustomMessage(msg.trim());
      } catch {
        /* keep default */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [organizationId]);

  const message = customMessage ?? ORG_BLOCKED_MESSAGE;

  return (
    <div
      role="main"
      aria-live="polite"
      className="min-h-screen flex flex-col items-center justify-center bg-background px-4"
    >
      <div className="max-w-md w-full text-center space-y-6">
        <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          PesoWise
        </p>
        <div className="flex justify-center">
          <div className="rounded-full p-5 bg-red-100 dark:bg-red-900/30">
            <ShieldAlert className="h-10 w-10 text-red-600 dark:text-red-400" aria-hidden="true" />
          </div>
        </div>
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">{ORG_BLOCKED_TITLE}</h1>
          <p className="text-muted-foreground text-base leading-relaxed whitespace-pre-wrap break-words">{message}</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void onSignOut()}>
          Sign out
        </Button>
        <p className="text-xs text-muted-foreground pt-4 border-t">PesoWise by Unimisk</p>
      </div>
    </div>
  );
}
