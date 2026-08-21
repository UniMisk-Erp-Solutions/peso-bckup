/**
 * Source guards proving the /admin/maintenance* path is fully isolated from
 * local PesoWise auth — see docs/maintenance/CLOUD_MAINTENANCE_CONTROL_PLANE.md
 * Decision E and §21/§23 ("Cloud admin route: bootstrapAuthSession NOT CALLED",
 * "admin Cloud Auth: no Local Supabase import/use").
 *
 * A full render of the admin routes would need to mock Cloud Auth network
 * calls end-to-end for marginal proof beyond what these source guards pin
 * exactly: that the forbidden imports are structurally absent. This matches
 * the established pattern for architectural-boundary tests elsewhere in this
 * suite (e.g. reviewMainSearchWiring.test.ts).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/** Strips block and line comments before a substring check, so explanatory
 * prose in a file's own header comment (e.g. "never imports X") cannot
 * produce a false-positive failure against itself. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function readCode(relPath: string): string {
  return stripComments(readFileSync(resolve(process.cwd(), relPath), "utf-8"));
}

const FORBIDDEN_IMPORTS = [
  "@/integrations/supabase/client",
  "@/contexts/AuthContext",
  "@/lib/authSession",
  "bootstrapAuthSession",
];

const ADMIN_FILES = [
  "src/maintenance/MaintenanceAdminApplication.tsx",
  "src/pages/maintenance-admin/MaintenanceAdminLogin.tsx",
  "src/pages/maintenance-admin/MaintenanceAdminDashboard.tsx",
  "src/integrations/maintenance-cloud/maintenanceAdminService.ts",
];

describe("Maintenance admin path — isolation from local PesoWise auth", () => {
  it.each(ADMIN_FILES)("%s never references local Supabase / local auth", (relPath) => {
    const src = readCode(relPath);
    for (const forbidden of FORBIDDEN_IMPORTS) {
      expect(src).not.toContain(forbidden);
    }
  });

  it("MaintenanceAdminApplication never imports MaintenanceBootstrap or LocalPesoWiseBootstrap", () => {
    const src = readCode("src/maintenance/MaintenanceAdminApplication.tsx");
    expect(src).not.toContain("MaintenanceBootstrap");
    expect(src).not.toContain("LocalPesoWiseBootstrap");
  });

  it("MaintenanceAdminApplication owns its own BrowserRouter (mutually exclusive with App.tsx's)", () => {
    const src = readCode("src/maintenance/MaintenanceAdminApplication.tsx");
    expect(src).toContain("BrowserRouter");
  });

  it("maintenanceAdminService uses the Cloud client, not the local one", () => {
    const src = readCode("src/integrations/maintenance-cloud/maintenanceAdminService.ts");
    expect(src).toContain('from "./client"');
  });
});

describe("main.tsx — routing decision structure", () => {
  // NOTE: comments are intentionally NOT stripped for this describe block's
  // structural checks (they need the real, full source with line numbers
  // intact for the indexOf-based ordering assertions below) — only the two
  // "must not contain" checks use the comment-stripped version, since main.tsx's
  // own explanatory comments legitimately reference these identifiers in prose.
  const mainSrcRaw = readFileSync(resolve(process.cwd(), "src/main.tsx"), "utf-8");
  const mainSrc = stripComments(mainSrcRaw);

  it("no longer imports or calls bootstrapAuthSession directly", () => {
    expect(mainSrc).not.toContain("bootstrapAuthSession");
    expect(mainSrc).not.toContain("@/lib/authSession");
  });

  it("no longer statically imports AuthProvider/I18nProvider/App at the top level", () => {
    expect(mainSrc).not.toContain('from "@/contexts/AuthContext"');
    expect(mainSrc).not.toContain('from "@/i18n/I18nProvider"');
    expect(mainSrc).not.toContain('from "./App.tsx"');
  });

  it("checks isMaintenanceAdminPath before choosing between the admin app and MaintenanceBootstrap", () => {
    expect(mainSrcRaw).toContain("isMaintenanceAdminPath");
    expect(mainSrcRaw).toContain("MaintenanceAdminApplication");
    expect(mainSrcRaw).toContain("MaintenanceBootstrap");

    const rootFnIdx = mainSrcRaw.indexOf("function Root()");
    expect(rootFnIdx).toBeGreaterThan(-1);
    const rootFnBody = mainSrcRaw.slice(rootFnIdx, rootFnIdx + 400);
    const isAdminPathIdx = rootFnBody.indexOf("isMaintenanceAdminPath");
    const adminAppIdx = rootFnBody.indexOf("MaintenanceAdminApplication");
    const bootstrapIdx = rootFnBody.indexOf("<MaintenanceBootstrap");
    expect(isAdminPathIdx).toBeGreaterThan(-1);
    expect(adminAppIdx).toBeGreaterThan(-1);
    expect(bootstrapIdx).toBeGreaterThan(-1);
    // the admin-path check and its branch must appear before the fallback branch
    expect(isAdminPathIdx).toBeLessThan(adminAppIdx);
    expect(adminAppIdx).toBeLessThan(bootstrapIdx);
  });
});
