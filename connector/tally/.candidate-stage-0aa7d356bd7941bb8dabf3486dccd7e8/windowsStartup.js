"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerConnectorLogonTask = registerConnectorLogonTask;
exports.registerPesoWiseUrlProtocol = registerPesoWiseUrlProtocol;
const child_process_1 = require("child_process");
const logger_js_1 = require("./logger.js");
/** Register logon task so sync starts after reboot (optional). */
function registerConnectorLogonTask() {
    const tr = `"${process.execPath}" run`;
    const create = (0, child_process_1.spawnSync)("schtasks.exe", ["/Create", "/F", "/TN", "PesoWiseSync", "/TR", tr, "/SC", "ONLOGON", "/RL", "LIMITED"], { encoding: "utf-8", windowsHide: true });
    if (create.status !== 0) {
        (0, logger_js_1.log)(`schtasks create failed: ${create.stderr || create.stdout}`);
        return false;
    }
    (0, logger_js_1.log)("Registered logon task PesoWiseSync");
    return true;
}
function registerPesoWiseUrlProtocol(appExe) {
    const proto = "pesowise-tally";
    const entries = [
        { sub: `Software\\Classes\\${proto}`, value: "URL:PesoWise Tally Connector" },
        { sub: `Software\\Classes\\${proto}\\URL Protocol`, value: "" },
        {
            sub: `Software\\Classes\\${proto}\\shell\\open\\command`,
            value: `"${appExe}" setup --from-url "%1"`,
        },
    ];
    for (const e of entries) {
        (0, child_process_1.spawnSync)("reg.exe", ["add", `HKCU\\${e.sub}`, "/ve", "/d", e.value, "/f"], {
            encoding: "utf-8",
            windowsHide: true,
        });
    }
}
