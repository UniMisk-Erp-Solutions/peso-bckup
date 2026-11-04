/**
 * "Setup" mode of the connector exe (no PowerShell, no script host, no VBS): this is what the installer runs.
 *   copy the program and the Tally file to %LOCALAPPDATA%\Programs\PesoWiseTally, pair with the code the user types,
 *   register a per-user start-at-sign-in entry (HKCU Run, no admin rights) and start the connector in the background.
 * The installed copy is switched to the Windows "GUI" subsystem so it never opens a console window.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";

/** Flip the PE "Subsystem" field to WINDOWS_GUI (2) so the program runs without a console window. Pure: returns a new buffer. */
export function toGuiSubsystem(exe: Buffer): Buffer {
  const out = Buffer.from(exe);
  if (out.length < 0x100 || out.readUInt16LE(0) !== 0x5a4d) throw new Error("not a Windows program");
  const pe = out.readUInt32LE(0x3c);
  if (pe + 0x60 > out.length || out.readUInt32LE(pe) !== 0x00004550) throw new Error("not a PE file");
  const optional = pe + 24;
  const magic = out.readUInt16LE(optional);
  if (magic !== 0x10b && magic !== 0x20b) throw new Error("unknown PE format");
  out.writeUInt16LE(2, optional + 68); // Subsystem is at offset 68 in both PE32 and PE32+
  return out;
}

/** Set by esbuild `define` in the stand-alone build (scripts/build-standalone.mjs); undefined otherwise. */
declare const PWT_EMBED_TDL: string | undefined;

export interface SetupDeps {
  /** where the installed program goes */
  destDir: string;
  /** the running (console) program and the files extracted next to it */
  selfExe: string;
  tdlSource: string;
  /** TDL text built into a stand-alone download (used instead of a file next to the program) */
  tdlText?: string;
  /** asks the user; resolves to the typed text */
  ask: (question: string) => Promise<string>;
  say: (line: string) => void;
  /** pairing is done by the caller-supplied function so tests can fake it */
  pair: (code: string) => Promise<void>;
  isPaired: () => boolean;
  stopOthers: () => void;
  registerStartup: (installedExe: string) => void;
  startNow: (installedExe: string) => void;
  doctor: () => Promise<void>;
  skipPair?: boolean;
  /** how long to wait for the connector to come up before reporting (tests use 0) */
  waitMs?: number;
}

/** Writes a file, retrying while another program holds it (an old connector still shutting down, or antivirus scanning the new file). */
export async function writeWithRetry(path: string, data: Buffer, attempts = 15, delayMs = 1000, write: (p: string, b: Buffer) => void = writeFileSync): Promise<void> {
  for (let i = 1; ; i++) {
    try {
      write(path, data);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (i >= attempts || !["EBUSY", "EPERM", "EACCES", "ETXTBSY"].includes(code ?? "")) throw e;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

/** runSetup that never throws: any failure is reported in plain words and the caller can keep the window open. */
export async function runSetupSafe(d: SetupDeps, onError: (e: Error) => void = () => undefined): Promise<number> {
  try {
    return await runSetup(d);
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    onError(err);
    d.say("");
    d.say("Setup could not finish.");
    d.say(`Reason: ${err.message}`);
    d.say("Close any older PesoWise Tally program (Task Manager), check that your antivirus did not remove the file, then run this setup again.");
    return 1;
  }
}

export async function runSetup(d: SetupDeps): Promise<number> {
  d.say("PesoWise Tally Setup");
  d.say("--------------------");
  // 1) stop a running copy, then copy the files
  d.stopOthers();
  mkdirSync(d.destDir, { recursive: true });
  const installed = join(d.destDir, "PesoWiseTally.exe");
  await writeWithRetry(installed, toGuiSubsystem(readFileSync(d.selfExe)));
  if (d.tdlText) await writeWithRetry(join(d.destDir, "PesoWise-Tally.tdl"), Buffer.from(d.tdlText, "utf-8"));
  else if (existsSync(d.tdlSource)) await writeWithRetry(join(d.destDir, "PesoWise-Tally.tdl"), readFileSync(d.tdlSource));
  d.say(`Installed to ${d.destDir}`);

  // 2) pair
  if (!d.skipPair) {
    let doPair = true;
    if (d.isPaired()) {
      const a = (await d.ask("This PC is already paired with PesoWise. Pair again with a NEW code? (y = new code, n = keep the current pairing) [n]: ")).trim().toLowerCase();
      doPair = a === "y" || a === "yes";
    }
    if (doPair) {
      const code = (await d.ask("Enter the pairing code shown in PesoWise (Tally integration page): ")).trim();
      if (!code) {
        d.say("No code entered. Setup stopped; run it again when you have a code.");
        return 1;
      }
      try {
        await d.pair(code);
      } catch (e) {
        const msg = (e as Error).message;
        d.say(`Pairing failed: ${msg}`);
        d.say(pairingAdvice(msg));
        return 1;
      }
    }
  }

  // 3) start at sign-in, and start now
  d.registerStartup(installed);
  d.startNow(installed);
  await new Promise((r) => setTimeout(r, d.waitMs ?? 3000));
  await d.doctor();
  d.say("");
  d.say("Next, in TallyPrime:");
  d.say("1. Press F1 (Help), then Settings > Connectivity > Client/Server configuration, and enable the Tally port.");
  d.say(`2. Add this TDL in TallyPrime: ${join(d.destDir, "PesoWise-Tally.tdl")}`);
  d.say("3. Open the company you paired, then press Sync to Tally in PesoWise.");
  return 0;
}

/** Real-world wiring used by the exe. */
export function realDeps(opts: { destDir: string; pair: (code: string) => Promise<void>; isPaired: () => boolean; doctor: () => Promise<void>; skipPair: boolean }): SetupDeps {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const selfExe = process.execPath;
  const runValue = process.env.PWT_RUN_VALUE ?? "PesoWise Tally Connector";
  return {
    destDir: opts.destDir,
    selfExe,
    tdlSource: join(dirname(selfExe), "PesoWise-Tally.tdl"),
    tdlText: typeof PWT_EMBED_TDL !== "undefined" ? PWT_EMBED_TDL : undefined,
    ask: (q) => rl.question(q),
    say: (l) => console.log(l),
    pair: opts.pair,
    isPaired: opts.isPaired,
    skipPair: opts.skipPair,
    doctor: opts.doctor,
    stopOthers: () => {
      try {
        execFileSync("taskkill", ["/F", "/IM", "PesoWiseTally.exe", "/FI", `PID ne ${process.pid}`], { stdio: "ignore" });
      } catch { /* none running */ }
    },
    registerStartup: (exe) => {
      if (process.env.PWT_SKIP_STARTUP === "1") return;
      execFileSync("reg", ["add", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", "/v", runValue, "/t", "REG_SZ", "/d", `"${exe}" run`, "/f"], { stdio: "ignore" });
    },
    startNow: (exe) => {
      // The packaged exe marks its children; clear the marker so the installed copy starts as the connector.
      const env = { ...process.env, PKG_EXECPATH: "" };
      spawn(exe, ["run"], { detached: true, stdio: "ignore", windowsHide: true, env }).unref();
    },
  };
}

/** What to do next, by the kind of failure. */
export function pairingAdvice(message: string): string {
  if (/^network:/i.test(message)) return "Nothing is wrong with the code. Fix the connection (see above), then run this setup again.";
  if (/\b429\b/.test(message)) return "Too many tries in a short time. Wait a minute, then run this setup again with the same code.";
  if (/\b5\d\d\b/.test(message)) return "The PesoWise server had a problem. Wait a minute and run this setup again with the same code (or get a new one).";
  if (/must use https|no server address/i.test(message)) return "This installer is not set up correctly. Download it again from PesoWise and run it.";
  return "The code may be wrong or expired (15 minutes). Get a new code in PesoWise and run this setup again.";
}
