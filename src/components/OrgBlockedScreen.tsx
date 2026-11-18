/**
 * OrgBlockedScreen -- full-page screen shown by ProtectedRoute when Master Admin
 * has ticked the `org_blocked` flag for the user's organization (DOC-165).
 *
 * The wording is a PLACEHOLDER: the owner will supply the final message later.
 * Change ORG_BLOCKED_MESSAGE in one place (src/lib/orgBlocked.ts) when it arrives.
 */
import { ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ORG_BLOCKED_MESSAGE, ORG_BLOCKED_TITLE } from "@/lib/orgBlocked";

type Props = {
  onSignOut: () => void | Promise<void>;
};

export function OrgBlockedScreen({ onSignOut }: Props) {
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
          <p className="text-muted-foreground text-base leading-relaxed">{ORG_BLOCKED_MESSAGE}</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void onSignOut()}>
          Sign out
        </Button>
        <p className="text-xs text-muted-foreground pt-4 border-t">PesoWise by Unimisk</p>
      </div>
    </div>
  );
}
