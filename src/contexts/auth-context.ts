import { createContext, useContext } from "react";
import type { Session, User } from "@supabase/supabase-js";
import type { AppLanguage } from "@/i18n/config";
import type { OrganizationFeatureKey } from "@/lib/organizationFeatureKeys";

export type AppRole =
  | "admin"
  | "engineer"
  | "employee"
  | "cashier"
  | "team_leader"
  | "executive"
  | "master_admin";

export interface UserProfile {
  id: string;
  name: string;
  email: string;
  organization_id: string | null;
  preferred_language?: string | null;
}

export interface Organization {
  id: string;
  name: string;
  slug: string;
  plan: string;
  logo_url?: string | null;
  strategy_slug?: string;
  subdomain?: string | null;
}

/**
 * Tenant organization lookup (get_organization_by_subdomain).
 * `not_found` (subdomain has no org) and `error` (RPC/network failure) are
 * deliberately distinct — see DOC-075.
 */
export type TenantResolutionStatus = "idle" | "loading" | "resolved" | "not_found" | "error";

/** Employee-ID-login capability lookup (get_organization_feature_enabled). */
export type TenantFeatureStatus = "idle" | "loading" | "resolved" | "error";

export interface AuthContextType {
  user: User | null;
  session: Session | null;
  userRole: AppRole | null;
  userProfile: UserProfile | null;
  organization: Organization | null;
  organizationId: string | null;
  loading: boolean;
  signOut: () => Promise<void>;
  refreshUserProfile: (userId?: string) => Promise<void>;
  refreshOrganization: () => Promise<void>;
  appBaseDomain: string;
  isTenantHost: boolean;
  tenantSubdomainLabel: string | null;
  tenantHostOrgId: string | null;
  tenantHostOrg: { id: string; name: string; slug: string; logo_url?: string | null } | null;
  organizationFeatureFlags: Record<string, boolean>;
  hasOrganizationFeature: (key: OrganizationFeatureKey) => boolean;
  tenantEmployeeIdLoginEnabled: boolean;
  tenantResolutionStatus: TenantResolutionStatus;
  tenantFeatureStatus: TenantFeatureStatus;
  retryTenantResolution: () => void;
  preferredLanguage: AppLanguage;
  setPreferredLanguage: (lang: AppLanguage) => Promise<void>;
  isAccountantCashier: boolean;
  userBalance: number | null;
  refreshBalance: () => Promise<void>;
}

/** Stable context instance — keep in this file so lazy routes survive Vite HMR. */
export const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
