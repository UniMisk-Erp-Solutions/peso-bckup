import { spawnSync } from "child_process";
import { log } from "./logger.js";
/** Register logon task so sync starts after reboot (optional). */
export function registerConnectorLogonTask(): boolean {
  const tr = `"${process.execPath}" run`;

  const create = spawnSync(
    "schtasks.exe",
    ["/Create", "/F", "/TN", "PesoWiseSync", "/TR", tr, "/SC", "ONLOGON", "/RL", "LIMITED"],
    { encoding: "utf-8", windowsHide: true },
  );
  if (create.status !== 0) {
    log(`schtasks create failed: ${create.stderr || create.stdout}`);
    return false;
  }
  log("Registered logon task PesoWiseSync");
  return true;
}

export function registerPesoWiseUrlProtocol(appExe: string): void {
  const proto = "pesowise-tally";
  const entries: { sub: string; value: string }[] = [
    { sub: `Software\\Classes\\${proto}`, value: "URL:PesoWise Tally Connector" },
    { sub: `Software\\Classes\\${proto}\\URL Protocol`, value: "" },
    {
      sub: `Software\\Classes\\${proto}\\shell\\open\\command`,
      value: `"${appExe}" setup --from-url "%1"`,
    },
  ];
  for (const e of entries) {
    spawnSync("reg.exe", ["add", `HKCU\\${e.sub}`, "/ve", "/d", e.value, "/f"], {
      encoding: "utf-8",
      windowsHide: true,
    });
  }
}
