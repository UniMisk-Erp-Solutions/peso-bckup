import { describe, expect, it } from "vitest";
import { isMaintenanceAdminPath } from "../MaintenanceAdminApplication";

describe("isMaintenanceAdminPath", () => {
  it("matches the exact dashboard path", () => {
    expect(isMaintenanceAdminPath("/admin/maintenance")).toBe(true);
  });

  it("matches the login path and any sub-path", () => {
    expect(isMaintenanceAdminPath("/admin/maintenance/login")).toBe(true);
    expect(isMaintenanceAdminPath("/admin/maintenance/anything")).toBe(true);
  });

  it("does not match unrelated admin paths", () => {
    expect(isMaintenanceAdminPath("/admin")).toBe(false);
    expect(isMaintenanceAdminPath("/admin/expenses")).toBe(false);
    expect(isMaintenanceAdminPath("/admin/maintenance-other")).toBe(false);
  });

  it("does not match ordinary application paths", () => {
    expect(isMaintenanceAdminPath("/")).toBe(false);
    expect(isMaintenanceAdminPath("/dashboard")).toBe(false);
    expect(isMaintenanceAdminPath("/master")).toBe(false);
    expect(isMaintenanceAdminPath("/auth")).toBe(false);
  });

  it("matches case-insensitively — the owner-reported route hardening gap", () => {
    expect(isMaintenanceAdminPath("/ADMIN/MAINTENANCE/LOGIN")).toBe(true);
    expect(isMaintenanceAdminPath("/Admin/Maintenance/Login")).toBe(true);
    expect(isMaintenanceAdminPath("/ADMIN/MAINTENANCE")).toBe(true);
    expect(isMaintenanceAdminPath("/aDmIn/mAiNtEnAnCe/lOgIn")).toBe(true);
  });

  it("stays exact-segment even with case variation — no accidental broadening", () => {
    expect(isMaintenanceAdminPath("/ADMIN/MAINTENANCEEVIL")).toBe(false);
    expect(isMaintenanceAdminPath("/admin/maintenanceevil")).toBe(false);
    expect(isMaintenanceAdminPath("/FOO/ADMIN/MAINTENANCE")).toBe(false);
    expect(isMaintenanceAdminPath("/foo/admin/maintenance")).toBe(false);
  });
});
