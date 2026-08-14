import type { LucideIcon } from "lucide-react";
import {
  Briefcase,
  Settings,
  Shield,
  User,
  Users,
  Wallet,
} from "lucide-react";

export type OrgRoleKey =
  | "admin"
  | "engineer"
  | "employee"
  | "cashier"
  | "team_leader"
  | "executive"
  | "master_admin";

export type RoleDisplayConfig = {
  defaultLabel: string;
  description: string;
  Icon: LucideIcon;
  iconBg: string;
  iconColor: string;
  badgeClass: string;
  headerAccentClass: string;
};

export const ROLE_DISPLAY: Record<OrgRoleKey, RoleDisplayConfig> = {
  employee: {
    defaultLabel: "Employee",
    description: "Create and submit expenses",
    Icon: User,
    iconBg: "bg-emerald-100",
    iconColor: "text-emerald-700",
    badgeClass: "bg-emerald-50 text-emerald-800 border-emerald-200",
    headerAccentClass: "text-emerald-700",
  },
  engineer: {
    defaultLabel: "Manager",
    description: "Review, verify, and approve expenses",
    Icon: Settings,
    iconBg: "bg-blue-100",
    iconColor: "text-blue-700",
    badgeClass: "bg-blue-50 text-blue-800 border-blue-200",
    headerAccentClass: "text-blue-700",
  },
  team_leader: {
    defaultLabel: "Team Leader",
    description: "Verify and edit at team tier",
    Icon: Users,
    iconBg: "bg-teal-100",
    iconColor: "text-teal-700",
    badgeClass: "bg-teal-50 text-teal-800 border-teal-200",
    headerAccentClass: "text-teal-700",
  },
  executive: {
    defaultLabel: "Executive",
    description: "Verify and edit at executive tier",
    Icon: Briefcase,
    iconBg: "bg-indigo-100",
    iconColor: "text-indigo-700",
    badgeClass: "bg-indigo-50 text-indigo-800 border-indigo-200",
    headerAccentClass: "text-indigo-700",
  },
  admin: {
    defaultLabel: "Administrator",
    description: "Full system access",
    Icon: Shield,
    iconBg: "bg-purple-100",
    iconColor: "text-purple-700",
    badgeClass: "bg-purple-50 text-purple-800 border-purple-200",
    headerAccentClass: "text-purple-700",
  },
  cashier: {
    defaultLabel: "Cashier",
    description: "Mark expenses as paid and manage payouts",
    Icon: Wallet,
    iconBg: "bg-amber-100",
    iconColor: "text-amber-700",
    badgeClass: "bg-amber-50 text-amber-800 border-amber-200",
    headerAccentClass: "text-amber-700",
  },
  master_admin: {
    defaultLabel: "Master Admin",
    description: "Platform-wide administration",
    Icon: Shield,
    iconBg: "bg-slate-100",
    iconColor: "text-slate-700",
    badgeClass: "bg-slate-100 text-slate-800 border-slate-300",
    headerAccentClass: "text-slate-700",
  },
};

export function normalizeOrgRole(role: string): OrgRoleKey | null {
  if (role in ROLE_DISPLAY) return role as OrgRoleKey;
  return null;
}

export function getRoleDisplayConfig(role: string): RoleDisplayConfig {
  const key = normalizeOrgRole(role);
  if (key) return ROLE_DISPLAY[key];
  return {
    defaultLabel: role.charAt(0).toUpperCase() + role.slice(1).replace(/_/g, " "),
    description: "",
    Icon: User,
    iconBg: "bg-slate-100",
    iconColor: "text-slate-600",
    badgeClass: "bg-slate-100 text-slate-700 border-slate-200",
    headerAccentClass: "text-slate-600",
  };
}

export function formatRoleLabel(
  role: string,
  labelOverrides?: Partial<Record<string, string>>,
): string {
  const key = normalizeOrgRole(role);
  if (key && labelOverrides?.[key]) return labelOverrides[key]!;
  if (key) return ROLE_DISPLAY[key].defaultLabel;
  return role.charAt(0).toUpperCase() + role.slice(1).replace(/_/g, " ");
}

/** Roles shown in user create/edit dropdowns (order matters). */
export const USER_FORM_ROLE_ORDER: OrgRoleKey[] = [
  "employee",
  "engineer",
  "team_leader",
  "executive",
  "admin",
  "cashier",
];

export function isRoleEnabledInForm(
  role: OrgRoleKey,
  options: { teamLeaderTierEnabled: boolean; executiveTierEnabled: boolean },
): boolean {
  if (role === "team_leader") return options.teamLeaderTierEnabled;
  if (role === "executive") return options.executiveTierEnabled;
  if (role === "master_admin") return false;
  return true;
}
