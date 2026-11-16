import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { spawn } from "child_process";
import { exchangePairingCode } from "./pesoApi.js";
import { saveConfig, configPath, configExists } from "./config.js";
import { loadSetupDefaults } from "./setupDefaults.js";
import { installBundledFiles, openFolderInExplorer } from "./installBundle.js";
import { TDL_INSTALL_DIR } from "./bundlePaths.js";
import { registerConnectorLogonTask, registerPesoWiseUrlProtocol } from "./windowsStartup.js";
import { newInstallationId } from "./randomId.js";
import { AGENT_VERSION } from "./doctor.js";
import { log } from "./logger.js";
import { notifyUser, spawnBackgroundSync } from "./launcher.js";
import { PRODUCT_NAME } from "./product.js";

const SETUP_PORT = 9877;
const VERSION = AGENT_VERSION;

export type SetupWizardOptions = {
  prefillCode?: string;
  openBrowser?: boolean;
};

function parseCodeFromCustomUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const raw = url.trim();
  const m = raw.match(/pesowise-tally:\/\/(?:connect\/)?([A-Za-z0-9]+)/i);
  if (m) return m[1].toUpperCase();
  if (/^[A-Za-z0-9]{6,12}$/.test(raw)) return raw.toUpperCase();
  return undefined;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function htmlPage(prefill: string, company: string, error?: string, done?: boolean): string {
  const errBlock = error ? `<p class="err">${escapeHtml(error)}</p>` : "";
  const doneBlock =
    done ?
      `<div class="ok">
        <h2>You're connected</h2>
        <p><strong>${escapeHtml(PRODUCT_NAME)}</strong> is running. The installer configures the two PesoWise TDL startup files when it detects TallyPrime and user TDLs are enabled.</p>
        <ol>
          <li>Restart TallyPrime once so the PesoWise reports load. If the installer could not detect a Tally installation, use <strong>F12</strong> to load <strong>PesoWise-Bootstrap.tdl</strong> + <strong>PesoWise-Load.tdl</strong> from <code>C:\\pesowise</code>.</li>
          <li>Open your company → <strong>F1</strong> → enable HTTP port <strong>9000</strong></li>
        </ol>
        <button type="button" onclick="fetch('/open-tdl-folder',{method:'POST'})">Open C:\\pesowise</button>
        <p class="hint">Then in PesoWise: <strong>Reports → Sync to Tally</strong>. Data shows under <strong>Gateway → PesoWise Reports</strong>.</p>
      </div>`
    : `<form method="POST" action="/connect">
        <label>Pairing code (PesoWise → Admin → Tally integration → Prepare this PC)</label>
        <input name="code" required maxlength="12" value="${escapeHtml(prefill)}" placeholder="e.g. A1B2C3D4" autofocus />
        <label>Tally company name</label>
        <input name="company" required value="${escapeHtml(company)}" />
        ${errBlock}
        <button type="submit">Connect &amp; start sync</button>
      </form>`;

  return `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>${escapeHtml(PRODUCT_NAME)}</title>
<style>
  body{font-family:Segoe UI,system-ui,sans-serif;max-width:520px;margin:40px auto;padding:0 16px;color:#111}
  h1{font-size:1.35rem} label{display:block;margin-top:14px;font-size:.85rem;color:#444}
  input{width:100%;box-sizing:border-box;padding:10px;margin-top:4px;font-size:1rem;border:1px solid #ccc;border-radius:6px}
  button{margin-top:20px;width:100%;padding:12px;font-size:1rem;background:#0f766e;color:#fff;border:none;border-radius:8px;cursor:pointer}
  button:hover{background:#0d9488}.err{color:#b91c1c}.ok{background:#ecfdf5;padding:16px;border-radius:8px;margin-top:12px}
  .hint{font-size:.85rem;color:#555} code{background:#f3f4f6;padding:2px 4px}
</style></head><body>
<h1>${escapeHtml(PRODUCT_NAME)} — one-time link</h1>
<p class="hint"><strong>Keep this window open</strong> until you click Connect and see &quot;You&apos;re connected&quot;. Paste the code from PesoWise → Admin → Tally → Prepare this PC.</p>
${doneBlock}
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}

export async function runSetupWizard(opts: SetupWizardOptions = {}): Promise<void> {
  if (configExists()) {
    log("Setup skipped — already paired");
    spawnBackgroundSync();
    notifyUser(
      "This PC is already linked to PesoWise.\n\nUse Reports → Sync to Tally in the website.\n\nTo pair again, delete the folder:\n%USERPROFILE%\\PesoWise\\TallyConnector",
      "PesoWise Sync",
    );
    return;
  }

  try {
    installBundledFiles();
  } catch (e) {
    log(`Install files warning: ${(e as Error).message}`);
  }

  const defaults = loadSetupDefaults();
  if (!defaults.peso_api_url || !defaults.anon_key) {
    console.error(
      "Setup is missing server configuration (setup-config.json). Download PesoWiseSync.exe again from PesoWise Admin → Tally.",
    );
    notifyUser(
      "This copy of PesoWiseSync.exe is missing server settings.\n\nDownload it again from PesoWise → Admin → Tally integration.",
      "PesoWise Sync — setup error",
    );
    process.exit(2);
  }

  let prefill = (opts.prefillCode ?? "").trim().toUpperCase();
  const companyDefault = defaults.default_tally_company;

  const server = createServer(async (req, res) => {
    const url = req.url ?? "/";
    if (req.method === "GET" && url === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(htmlPage(prefill, companyDefault));
      return;
    }
    if (req.method === "POST" && url === "/open-tdl-folder") {
      openFolderInExplorer(TDL_INSTALL_DIR);
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === "POST" && url === "/connect") {
      const body = await readBody(req);
      const params = new URLSearchParams(body);
      const code = String(params.get("code") ?? "").trim().toUpperCase();
      const company = String(params.get("company") ?? "").trim();
      const device = String(params.get("device") ?? "PesoWise Connector").trim();
      try {
        if (!code || code.length < 6) throw new Error("Enter the pairing code from the website");
        if (!company) throw new Error("Enter your Tally company name");
        const installationId = newInstallationId();
        const result = await exchangePairingCode(
          defaults.peso_api_url,
          defaults.anon_key,
          code,
          device,
          installationId,
          VERSION,
        );
        saveConfig({
          configVersion: 1,
          pesoApiUrl: defaults.peso_api_url,
          deviceToken: result.device_token,
          connectorId: result.connector_id,
          organizationId: result.organization_id,
          installationId,
          tallyCompanyName: company,
          tallyHost: "127.0.0.1",
          tallyPort: 9000,
        });
        registerConnectorLogonTask();
        registerPesoWiseUrlProtocol(process.execPath);
        spawnBackgroundSync();
        openFolderInExplorer(TDL_INSTALL_DIR);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(htmlPage(code, company, undefined, true));
        setTimeout(() => server.close(), 500);
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Connection failed";
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(htmlPage(code, company || companyDefault, msg));
      }
      return;
    }
    res.writeHead(404);
    res.end("Not found");
  });

  await new Promise<void>((resolve) => {
    server.listen(SETUP_PORT, "127.0.0.1", () => {
      log(`Setup wizard http://127.0.0.1:${SETUP_PORT}/`);
      resolve();
    });
  });

  if (opts.openBrowser !== false) {
    const openUrl = `http://127.0.0.1:${SETUP_PORT}/`;
    setTimeout(() => {
      spawn("cmd", ["/c", "start", "", openUrl], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      }).unref();
    }, 800);
  }

  await new Promise<void>((resolve) => {
    server.on("close", () => resolve());
  });
}

export function resolveSetupPrefill(argv: Record<string, unknown>): string | undefined {
  const fromArg = argv.code ?? argv["pairing-code"];
  if (fromArg) return parseCodeFromCustomUrl(String(fromArg));
  const fromUrl = argv["from-url"];
  if (fromUrl) return parseCodeFromCustomUrl(String(fromUrl));
  return undefined;
}
