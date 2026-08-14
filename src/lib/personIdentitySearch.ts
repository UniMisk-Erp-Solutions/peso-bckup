/**
 * Person Identity Search
 *
 * Pure helpers for building search tokens, matching queries, and formatting
 * identity sub-lines for people (users/employees) according to the active
 * OrganizationIdentityPolicy.
 *
 * All functions are pure — no Supabase calls, no React imports.
 */

import type { OrganizationIdentityPolicy } from "./organizationIdentityMode";

export type PersonIdentitySearchRow = {
  name?: string | null;
  email?: string | null;
  employee_id?: string | null;
  role?: string | null;
};

/**
 * Parse only the employee-ID portion from a synthetic auth email.
 * Format: emp.{orgSlug}.{employeeId}.{suffix}@{domain}
 * Returns "" when the email does not match the synthetic pattern.
 */
export function employeeIdFromSyntheticEmail(email: string): string {
  const match = email.trim().match(/^emp\.[^.]+\.([^.@]+)\./i);
  return match?.[1]?.trim() ?? "";
}

/**
 * Build the set of lower-cased search tokens for a person row according to
 * the active identity policy.
 *
 * Rules:
 *   email_only            → name, email, role
 *   employee_id_and_email → name, employee_id, email, role
 *   employee_id_only      → name, employee_id (or synthetic-parsed ID), role
 *                           NEVER the full synthetic email
 */
export function buildPersonIdentityTokens(
  person: PersonIdentitySearchRow,
  policy: OrganizationIdentityPolicy,
): string[] {
  const tokens: string[] = [];

  const add = (val: string | null | undefined) => {
    const t = String(val ?? "").trim();
    if (t) tokens.push(t.toLowerCase());
  };

  // Name — always searched
  add(person.name);

  // Employee ID
  if (policy.includeEmployeeIdInSearch) {
    if (person.employee_id) {
      add(person.employee_id);
    } else if (policy.allowSyntheticEmployeeIdFallback && person.email) {
      // Extract only the ID fragment — never the full synthetic email
      const extracted = employeeIdFromSyntheticEmail(person.email);
      if (extracted) add(extracted);
    }
  }

  // Real email — only when the policy says it is user-facing
  if (policy.includeEmailInSearch) {
    add(person.email);
  }

  // Role — always searched where passed
  add(person.role);

  return tokens;
}

/**
 * Returns true when the person matches the search query under the given policy.
 *
 * @param extras  Additional pre-computed lower-cased tokens (e.g. role display label).
 */
export function matchesPersonIdentitySearch(
  person: PersonIdentitySearchRow,
  query: string,
  policy: OrganizationIdentityPolicy,
  extras?: string[],
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;

  const tokens = buildPersonIdentityTokens(person, policy);
  if (extras) {
    for (const e of extras) {
      const t = String(e ?? "").trim().toLowerCase();
      if (t) tokens.push(t);
    }
  }

  return tokens.some((t) => t.includes(q));
}

/**
 * Format a short identity sub-line shown beneath a person's name in lists/cards.
 *
 *   employee_id_only      → "ID: <employee_id>" or "Employee ID unavailable"
 *                           NEVER the synthetic email
 *   employee_id_and_email → "ID: <employee_id>" (email shown separately where space permits)
 *   email_only            → the email address
 */
export function formatPersonIdentitySubline(
  person: PersonIdentitySearchRow,
  policy: OrganizationIdentityPolicy,
  fallbackLabel = "Employee ID unavailable",
): string {
  if (policy.employeeIdEnabled) {
    if (person.employee_id) {
      return `ID: ${person.employee_id}`;
    }
    if (policy.allowSyntheticEmployeeIdFallback && person.email) {
      const extracted = employeeIdFromSyntheticEmail(person.email);
      if (extracted) return `ID: ${extracted}`;
    }
    return fallbackLabel;
  }
  // Email-only mode
  return person.email ?? "";
}
