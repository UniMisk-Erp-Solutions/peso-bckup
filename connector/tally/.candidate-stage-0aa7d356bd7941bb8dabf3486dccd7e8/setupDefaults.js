"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadSetupDefaults = loadSetupDefaults;
const fs_1 = require("fs");
const path_1 = require("path");
const bundlePaths_js_1 = require("./bundlePaths.js");
const FALLBACK = {
    peso_api_url: "",
    anon_key: "",
    default_tally_company: "PesoWise Integration Test",
};
function loadSetupDefaults() {
    const root = (0, bundlePaths_js_1.bundleRoot)();
    const candidates = [
        (0, path_1.join)(root, "setup-config.json"),
        (0, path_1.join)((0, bundlePaths_js_1.executableDirectory)(), "setup-config.json"),
        (0, path_1.join)((0, bundlePaths_js_1.executableDirectory)(), "bundle", "setup-config.json"),
    ];
    for (const p of candidates) {
        if (!(0, fs_1.existsSync)(p))
            continue;
        try {
            const raw = JSON.parse((0, fs_1.readFileSync)(p, "utf-8").replace(/^\uFEFF/, ""));
            return {
                peso_api_url: String(raw.peso_api_url ?? "").trim(),
                anon_key: String(raw.anon_key ?? "").trim(),
                default_tally_company: String(raw.default_tally_company ?? FALLBACK.default_tally_company).trim(),
            };
        }
        catch {
            /* try next */
        }
    }
    return { ...FALLBACK };
}
