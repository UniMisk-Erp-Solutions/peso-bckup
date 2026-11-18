export interface Organization {
  id: string;
  name: string;
  slug: string;
  plan: string | null;
  payment_status: string | null;
  is_blocked: boolean | null;
  last_activity_at: string | null;
  created_at: string;
  max_users: number | null;
  subdomain?: string | null;
  strategy_slug?: string;
}

/** Fields Master Admin may update on `organizations` (same shape the page always used). */
export type OrganizationUpdates = {
  plan?: string | null;
  payment_status?: string | null;
  max_users?: number | null;
  subdomain?: string | null;
  strategy_slug?: string;
};

export type StrategyOption = { slug: string; label: string };

export const PLAN_OPTIONS = ["starter", "free-trial", "pro"] as const;
export const PAYMENT_OPTIONS = ["active", "pending", "overdue", "suspended", "cancelled"] as const;

/** Subdomain rule used when saving a tenant subdomain. */
export const SUBDOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
