import { describe, it, expect } from "vitest";
import { I18N_NAMESPACES } from "@/i18n/config";

describe("locale files", () => {
  for (const ns of I18N_NAMESPACES) {
    it(`loads en/${ns}.json`, async () => {
      const mod = await import(`../../locales/en/${ns}.json`);
      expect(mod.default).toBeTruthy();
    });
    it(`loads hi/${ns}.json`, async () => {
      const mod = await import(`../../locales/hi/${ns}.json`);
      expect(mod.default).toBeTruthy();
    });
    it(`loads gu/${ns}.json`, async () => {
      const mod = await import(`../../locales/gu/${ns}.json`);
      expect(mod.default).toBeTruthy();
    });
  }
});
