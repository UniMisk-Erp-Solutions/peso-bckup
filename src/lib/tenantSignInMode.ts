/**
 * Derives what the sign-in identifier field may accept, from the two independent
 * tenant lookups. Pure + synchronous so the Auth page and its tests agree.
 *
 * The bug this replaces: `isTenantHost && tenantEmployeeIdLoginEnabled` collapsed
 * "still loading" and "the feature RPC failed" into "employee ID login is off",
 * so a numeric ID like 5003 was rejected with "Enter your email address (include @)".
 */

import type { TenantFeatureStatus, TenantResolutionStatus } from "@/contexts/auth-context";

export type TenantSignInMode =
  /** Not a tenant host — apex email-only sign-in. */
  | "apex_email"
  /** Tenant org and/or capability still resolving — accept nothing yet, show a spinner. */
  | "loading"
  /** Employee ID or email both accepted. */
  | "employee_or_email"
  /** Tenant resolved, feature explicitly disabled — email only. */
  | "tenant_email_only"
  /** Subdomain has no organization record. */
  | "not_configured"
  /** A lookup failed (network/RPC). Offer Retry; do NOT claim the feature is off. */
  | "unavailable";

export type TenantSignInModeInput = {
  isTenantHost: boolean;
  tenantResolutionStatus: TenantResolutionStatus;
  tenantFeatureStatus: TenantFeatureStatus;
  tenantEmployeeIdLoginEnabled: boolean;
};

export function resolveTenantSignInMode(input: TenantSignInModeInput): TenantSignInMode {
  if (!input.isTenantHost) return "apex_email";

  switch (input.tenantResolutionStatus) {
    case "idle":
    case "loading":
      return "loading";
    case "error":
      return "unavailable";
    case "not_found":
      return "not_configured";
    case "resolved":
      break;
  }

  switch (input.tenantFeatureStatus) {
    case "idle":
    case "loading":
      return "loading";
    case "error":
      return "unavailable";
    case "resolved":
      return input.tenantEmployeeIdLoginEnabled ? "employee_or_email" : "tenant_email_only";
  }
}

/** True when a value without "@" may be submitted as an employee ID. */
export function acceptsEmployeeId(mode: TenantSignInMode): boolean {
  return mode === "employee_or_email";
}

/** True when the identifier field should be labelled "Employee ID or Email". */
export function showsEmployeeIdLabel(mode: TenantSignInMode): boolean {
  return mode === "employee_or_email";
}

/**
 * True when the UI may state "email only". Never true while loading or after a
 * failed lookup — those are unknown, not disabled.
 */
export function showsEmailOnlyLabel(mode: TenantSignInMode): boolean {
  return mode === "apex_email" || mode === "tenant_email_only";
}

/** True when a Retry control should be offered for tenant resolution. */
export function offersRetry(mode: TenantSignInMode): boolean {
  return mode === "unavailable";
}

/** True while the tenant is genuinely unresolved and the form must stay disabled. */
export function blocksSubmit(mode: TenantSignInMode): boolean {
  return mode === "loading" || mode === "unavailable" || mode === "not_configured";
}
