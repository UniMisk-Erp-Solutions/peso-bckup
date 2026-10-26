import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runSetup, toGuiSubsystem, type SetupDeps } from "../setup.ts";

/** A minimal fake PE file: "MZ", e_lfanew -> "PE\0\0", optional header magic, console subsystem (3). */
function fakeExe(magic = 0x20b): Buffer {
  const b = Buffer.alloc(0x400);
  b.writeUInt16LE(0x5a4d, 0);
  b.writeUInt32LE(0x80, 0x3c);
  b.writeUInt32LE(0x00004550, 0x80);
  b.writeUInt16LE(magic, 0x80 + 24);
  b.writeUInt16LE(3, 0x80 + 24 + 68);
  b.write("payload", 0x300);
  return b;
}

describe("installed copy has no console window", () => {
  it("switches the PE subsystem to GUI and changes nothing else", () => {
    for (const magic of [0x10b, 0x20b]) {
      const src = fakeExe(magic);
      const out = toGuiSubsystem(src);
      expect(out.readUInt16LE(0x80 + 24 + 68)).toBe(2);
      const a = Buffer.from(src); a.writeUInt16LE(2, 0x80 + 24 + 68);
      expect(out.equals(a)).toBe(true);
      expect(src.readUInt16LE(0x80 + 24 + 68)).toBe(3); // input untouched
    }
  });
  it("refuses a file that is not a Windows program", () => {
    expect(() => toGuiSubsystem(Buffer.alloc(0x400))).toThrow();
  });
});

function deps(over: Partial<SetupDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pwtsetup-"));
  const selfExe = join(dir, "self.exe");
  writeFileSync(selfExe, fakeExe());
  writeFileSync(join(dir, "PesoWise-Tally.tdl"), "tdl");
  const calls: string[] = [];
  const said: string[] = [];
  const d: SetupDeps = {
    destDir: join(dir, "dest"), selfExe, tdlSource: join(dir, "PesoWise-Tally.tdl"),
    ask: async () => "ABCD2345", say: (l) => said.push(l),
    pair: async (c) => { calls.push(`pair:${c}`); }, isPaired: () => false,
    stopOthers: () => calls.push("stop"), registerStartup: (e) => calls.push(`startup:${e.endsWith("PesoWiseTally.exe")}`),
    waitMs: 0, startNow: () => calls.push("start"), doctor: async () => { calls.push("doctor"); },
    ...over,
  };
  return { d, calls, said, dir };
}

describe("setup flow (no PowerShell)", () => {
  it("copies the program (GUI) and the TDL, pairs with the typed code, registers startup, starts, reports", async () => {
    const { d, calls, said } = deps();
    expect(await runSetup(d)).toBe(0);
    expect(calls).toEqual(["stop", "pair:ABCD2345", "startup:true", "start", "doctor"]);
    expect(readFileSync(join(d.destDir, "PesoWise-Tally.tdl"), "utf8")).toBe("tdl");
    expect(readFileSync(join(d.destDir, "PesoWiseTally.exe")).readUInt16LE(0x80 + 24 + 68)).toBe(2);
    expect(said.join("\n")).toContain("Add this TDL in TallyPrime");
  });
  it("stops cleanly (and starts nothing) when no code is typed", async () => {
    const { d, calls } = deps({ ask: async () => "  " });
    expect(await runSetup(d)).toBe(1);
    expect(calls).toEqual(["stop"]);
  });
  it("reports a failed pairing and does not register or start anything", async () => {
    const { d, calls, said } = deps({ pair: async () => { throw new Error("invalid code"); } });
    expect(await runSetup(d)).toBe(1);
    expect(said.join("\n")).toContain("Pairing failed: invalid code");
    expect(calls).toEqual(["stop"]);
  });
  it("keeps an existing pairing unless the user asks for a new code", async () => {
    const keep = deps({ isPaired: () => true, ask: async () => "n" });
    expect(await runSetup(keep.d)).toBe(0);
    expect(keep.calls).toEqual(["stop", "startup:true", "start", "doctor"]);
    const again = deps({ isPaired: () => true, ask: async (q) => (q.startsWith("This PC") ? "y" : "NEWCODE1") });
    expect(await runSetup(again.d)).toBe(0);
    expect(again.calls).toContain("pair:NEWCODE1");
  });
  it("--no-pair style run installs without pairing", async () => {
    const { d, calls, dir } = deps({ skipPair: true });
    expect(await runSetup(d)).toBe(0);
    expect(calls).toEqual(["stop", "startup:true", "start", "doctor"]);
    expect(existsSync(join(dir, "dest", "PesoWiseTally.exe"))).toBe(true);
  });
});

import { runSetupSafe, writeWithRetry } from "../setup.ts";
describe("setup never closes silently", () => {
  it("retries while another program holds the file (an old connector still stopping, antivirus scanning)", async () => {
    let n = 0;
    await writeWithRetry("x", Buffer.from("a"), 5, 0, () => { n += 1; if (n < 3) throw Object.assign(new Error("busy"), { code: "EBUSY" }); });
    expect(n).toBe(3);
  });
  it("gives up on a different error, or after too many tries", async () => {
    await expect(writeWithRetry("x", Buffer.from("a"), 5, 0, () => { throw Object.assign(new Error("no"), { code: "ENOENT" }); })).rejects.toThrow("no");
    let n = 0;
    await expect(writeWithRetry("x", Buffer.from("a"), 3, 0, () => { n += 1; throw Object.assign(new Error("busy"), { code: "EBUSY" }); })).rejects.toThrow("busy");
    expect(n).toBe(3);
  });
  it("reports a failure in plain words instead of throwing", async () => {
    const { d, said } = deps({ selfExe: join(tmpdir(), "does-not-exist.exe") });
    const seen: string[] = [];
    expect(await runSetupSafe(d, (e) => seen.push(e.message))).toBe(1);
    expect(said.join("\n")).toContain("Setup could not finish.");
    expect(said.join("\n")).toContain("Reason:");
    expect(seen).toHaveLength(1);
  });
});

import { pairingAdvice } from "../setup.ts";
import { explainNetworkError } from "../runtime.ts";

describe("plain error messages", () => {
  it("names the network problem and the host", () => {
    const u = "https://pesowise-backup-supabase.unimisk.com/functions/v1/pwt-connector";
    expect(explainNetworkError(Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } }), u)).toMatch(/cannot find the PesoWise server \(pesowise-backup-supabase\.unimisk\.com\)/);
    expect(explainNetworkError(new DOMException("signal timed out", "TimeoutError"), u)).toMatch(/did not answer in time/);
    expect(explainNetworkError(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }), u)).toMatch(/refused the connection/);
    expect(explainNetworkError(Object.assign(new TypeError("fetch failed"), { cause: { code: "CERT_HAS_EXPIRED" } }), u)).toMatch(/certificate problem/);
    expect(explainNetworkError(new TypeError("fetch failed"), u)).toMatch(/cannot reach the PesoWise server/);
  });
  it("gives the right next step for each pairing failure", () => {
    expect(pairingAdvice("network: this PC cannot reach the PesoWise server (x)")).toMatch(/Nothing is wrong with the code/);
    expect(pairingAdvice("PesoWise API 401: invalid or expired pairing code")).toMatch(/wrong or expired/);
    expect(pairingAdvice("PesoWise API 429: slow down")).toMatch(/Wait a minute/);
    expect(pairingAdvice("PesoWise API 503: x")).toMatch(/server had a problem/);
  });
});
