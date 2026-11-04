/**
 * GlitchTip EMERGENCY mode (GLITCHTIP_SOURCEMAP_REQUIRED).
 *
 * While GlitchTip is unreachable its source-map UPLOAD may be made non-blocking so an urgent fix can ship. The switch is
 * strict by default, reversible by an env value alone, and may relax ONLY the network upload step.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { sourcemapUploadRequired } from "../../../scripts/lib/glitchtipCli.mjs";

const ROOT = process.cwd();
const script = readFileSync(resolve(ROOT, "scripts/glitchtip-sourcemaps.mjs"), "utf-8");
const code = script.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("sourcemapUploadRequired: strict unless explicitly relaxed", () => {
  it.each([undefined, "", "true", "TRUE", "1", "yes", "on", "required", "flase", "fasle", "maybe"])(
    "%j => REQUIRED (a typo or unknown value can never weaken the safeguard)",
    (v) => {
      expect(sourcemapUploadRequired({ GLITCHTIP_SOURCEMAP_REQUIRED: v })).toBe(true);
    },
  );

  it.each(["false", "FALSE", " False ", "0", "no", "off", "OFF"])("%j => NOT required (explicit emergency setting)", (v) => {
    expect(sourcemapUploadRequired({ GLITCHTIP_SOURCEMAP_REQUIRED: v })).toBe(false);
  });

  it("an unset variable (the normal, post-recovery state) is strict", () => {
    expect(sourcemapUploadRequired({})).toBe(true);
    expect(sourcemapUploadRequired(undefined)).toBe(true);
  });
});

describe("the script relaxes ONLY the upload step", () => {
  it("strict mode still calls fail() for a failed upload", () => {
    expect(code).toMatch(/if \(sourcemapUploadRequired\(process\.env\)\) \{\s*fail\("source-map upload failed\."\);\s*\}/);
  });

  it("emergency mode logs a clear warning and continues the build", () => {
    expect(code).toMatch(/WARNING: GlitchTip unavailable — sourcemap upload skipped\/failed\. Application build continues\./);
    expect(code).toMatch(/GLITCHTIP_SOURCEMAP_REQUIRED=false is an EMERGENCY setting/);
  });

  it("CLI install, checksum, execution and debug-ID injection stay fatal regardless of the flag", () => {
    expect(code).toMatch(/fail\(`could not obtain glitchtip-cli/);
    expect(code).toMatch(/fail\("glitchtip-cli was obtained but does not execute on this platform\."\)/);
    expect(code).toMatch(/fail\("debug-ID injection failed\."\)/);
    // none of those is inside a flag check
    const flagChecks = code.match(/sourcemapUploadRequired\(/g) ?? [];
    expect(flagChecks).toHaveLength(1);
  });

  it("source maps are still removed from dist/ in emergency mode (original sources are never deployed)", () => {
    expect(code).toMatch(/pruneMaps\("upload failed in non-blocking emergency mode"\)/);
  });

  it("the bypass is environment-controlled only: no hard-coded constant disables the upload", () => {
    expect(code).not.toMatch(/const\s+(?:SKIP|BYPASS|DISABLE)\w*\s*=\s*true/i);
    expect(code).toMatch(/sourcemapUploadRequired,/);
  });

  it("the token is still never logged in the warning path", () => {
    const warnBlock = code.slice(code.indexOf("EMERGENCY MODE") === -1 ? code.indexOf("WARNING: GlitchTip") : code.indexOf("WARNING: GlitchTip"));
    expect(warnBlock.slice(0, 600)).not.toMatch(/SENTRY_AUTH_TOKEN/);
  });
});
