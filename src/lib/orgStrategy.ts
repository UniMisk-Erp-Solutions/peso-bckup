/**
 * Organization product strategy (organizations.strategy_slug). Branch custom behavior with:
 *   switch (getStrategySlug(organization)) { case "microlink_v1": ... }
 */
export function getStrategySlug(org: { strategy_slug?: string | null } | null | undefined): string {
  const s = org?.strategy_slug?.trim();
  return s || "standard";
}
