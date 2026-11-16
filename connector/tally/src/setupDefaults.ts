import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { bundleRoot, executableDirectory } from "./bundlePaths.js";

export type SetupDefaults = {
  peso_api_url: string;
  anon_key: string;
  default_tally_company: string;
};

const FALLBACK: SetupDefaults = {
  peso_api_url: "",
  anon_key: "",
  default_tally_company: "PesoWise Integration Test",
};

export function loadSetupDefaults(): SetupDefaults {
  const root = bundleRoot();
  const candidates = [
    join(root, "setup-config.json"),
    join(executableDirectory(), "setup-config.json"),
    join(executableDirectory(), "bundle", "setup-config.json"),
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const raw = JSON.parse(readFileSync(p, "utf-8").replace(/^\uFEFF/, "")) as Partial<SetupDefaults>;
      return {
        peso_api_url: String(raw.peso_api_url ?? "").trim(),
        anon_key: String(raw.anon_key ?? "").trim(),
        default_tally_company: String(raw.default_tally_company ?? FALLBACK.default_tally_company).trim(),
      };
    } catch {
      /* try next */
    }
  }
  return { ...FALLBACK };
}
