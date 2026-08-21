/**
 * Shared "why is this row still waiting" presentation helper (DOC-098 Part 9).
 * Pure and framework-free. Prefers authoritative backend fields
 * (approval_tier) over inferring purely from status text.
 */

export type WaitingReasonInput = {
  approval_tier?: string | null;
  status?: string | null;
};

/** Human label for the tier a waiting row is pending at. */
export function waitingReasonLabel(input: WaitingReasonInput): string {
  const tier = (input.approval_tier ?? "").toLowerCase();
  switch (tier) {
    case "team_leader":
      return "Waiting for Team Leader";
    case "executive":
      return "Waiting for Executive";
    case "engineer":
      return "Waiting for Manager review";
    case "admin":
      return "Waiting for Admin";
    default:
      break;
  }
  // No authoritative tier — fall back to a generic status-derived label
  // rather than guessing a specific stage.
  const status = (input.status ?? "").toLowerCase();
  if (status === "level_1_verified") return "Waiting for Executive";
  return "Waiting for previous verification";
}
