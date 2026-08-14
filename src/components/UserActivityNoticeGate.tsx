/**
 * UserActivityNoticeGate
 *
 * Guards the UserActivityTracker behind a one-time acknowledgement notice.
 *
 * Rules:
 *  - Feature disabled OR userRole === "master_admin" → tracker renders normally
 *    (tracker has its own shouldRun guard and will stay idle).
 *  - Feature enabled + not yet acknowledged → show notice modal; tracker receives
 *    noticeAcknowledged=false and does NOT start.
 *  - Feature enabled + acknowledged → tracker receives noticeAcknowledged=true
 *    and runs normally.
 *  - While RPC check is loading → render nothing (tracker must not start).
 *
 * The notice RPC result is cached for 5 minutes via React Query.
 * After the user clicks "I understand", the query is invalidated so the
 * tracker starts immediately without a full page reload.
 */

import { useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { ORGANIZATION_FEATURE_KEYS } from "@/lib/organizationFeatureKeys";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { UserActivityTracker } from "@/components/UserActivityTracker";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Eye, ShieldCheck } from "lucide-react";

const NOTICE_VERSION = "user_activity_notice_v1";

export function UserActivityNoticeGate() {
  const { user, userRole, hasOrganizationFeature } = useAuth();
  const queryClient = useQueryClient();
  const [acknowledging, setAcknowledging] = useState(false);
  const [ackError, setAckError] = useState(false);

  const featureEnabled = hasOrganizationFeature(
    ORGANIZATION_FEATURE_KEYS.user_activity_insights
  );
  const isMasterAdmin = userRole === "master_admin";

  const shouldQuery = !!user && featureEnabled && !isMasterAdmin;

  const { data: acknowledged, isLoading } = useQuery({
    queryKey: ["user-activity-notice-ack", user?.id],
    enabled: shouldQuery,
    queryFn: async () => {
      const { data, error } = await supabase.rpc(
        "has_acknowledged_user_activity_notice",
        { p_notice_version: NOTICE_VERSION }
      );
      if (error) {
        console.warn(
          "[UserActivityNoticeGate] has_acknowledged check failed:",
          error.message
        );
        return false;
      }
      return data as boolean;
    },
    staleTime: 5 * 60_000,
  });

  const handleAcknowledge = async () => {
    setAcknowledging(true);
    setAckError(false);
    try {
      const { error } = await supabase.rpc("acknowledge_user_activity_notice", {
        p_notice_version: NOTICE_VERSION,
      });
      if (error) throw error;
      await queryClient.invalidateQueries({
        queryKey: ["user-activity-notice-ack", user?.id],
      });
    } catch (e) {
      console.warn("[UserActivityNoticeGate] acknowledge failed:", e);
      setAckError(true);
    } finally {
      setAcknowledging(false);
    }
  };

  // Feature off or master_admin: pass through to tracker (tracker guards itself)
  if (!featureEnabled || isMasterAdmin) {
    return <UserActivityTracker noticeAcknowledged={true} />;
  }

  // RPC still loading: render nothing — tracker must NOT start yet
  if (isLoading) return null;

  // Not yet acknowledged: show blocking modal
  if (!acknowledged) {
    return (
      <>
        {/* Tracker rendered but blocked — noticeAcknowledged=false keeps it idle */}
        <UserActivityTracker noticeAcknowledged={false} />

        <Dialog open>
          <DialogContent
            className="max-w-lg"
            onPointerDownOutside={(e) => e.preventDefault()}
            onEscapeKeyDown={(e) => e.preventDefault()}
          >
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-lg font-semibold">
                <Eye className="h-5 w-5 text-blue-500 shrink-0" />
                Activity Insights is enabled
              </DialogTitle>
              <DialogDescription className="sr-only">
                Activity tracking notice for your organization
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 text-sm text-gray-700">
              <p>
                Your organization has enabled{" "}
                <strong>User Activity Insights</strong> in PesoWise.
              </p>

              <p>
                PesoWise records limited in-app activity data such as session
                start time, last seen time, visible app usage time, session
                count, and number of expenses submitted per day.
              </p>

              {/* What is NOT tracked */}
              <div className="rounded-lg bg-green-50 border border-green-100 p-3 space-y-1.5">
                <div className="flex items-center gap-1.5">
                  <ShieldCheck className="h-3.5 w-3.5 text-green-600 shrink-0" />
                  <p className="text-xs font-semibold text-green-800 uppercase tracking-wide">
                    What PesoWise does NOT track
                  </p>
                </div>
                <p className="text-xs text-green-700 leading-relaxed">
                  Keystrokes · Screenshots · Screen recording · Mouse
                  movement · Websites · Other browser tabs · Other apps ·
                  Location · Camera · Microphone · Any activity outside
                  PesoWise
                </p>
              </div>

              <p>
                This information is visible only to authorized organization
                admins and is used for workflow visibility, attendance/activity
                review, expense operations, and administrative reporting.
              </p>

              <p className="text-xs text-gray-500 leading-relaxed">
                <strong>Retention:</strong> Activity data is kept according to
                your organization's configured retention policy.
              </p>

              <p className="text-xs text-gray-500 leading-relaxed">
                For access, correction, or deletion requests, contact your
                organization admin or support according to your organization's
                policy.
              </p>

              {ackError && (
                <p className="text-red-500 text-xs font-medium">
                  Could not save acknowledgement. Please refresh and try again.
                </p>
              )}

              <p className="text-xs text-gray-400">
                By continuing, you acknowledge that this activity notice has
                been shown to you. See the full{" "}
                <Link
                  to="/legal/activity-insights"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline hover:no-underline text-gray-500"
                >
                  Activity Insights Notice
                </Link>{" "}
                and{" "}
                <Link
                  to="/privacy"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline hover:no-underline text-gray-500"
                >
                  Privacy Policy
                </Link>
                .
              </p>
            </div>

            <div className="pt-2">
              <Button
                className="w-full"
                disabled={acknowledging}
                onClick={handleAcknowledge}
              >
                {acknowledging ? "Saving…" : "I understand"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </>
    );
  }

  // Acknowledged: tracker runs normally
  return <UserActivityTracker noticeAcknowledged={true} />;
}
