import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("PesoWise Tally customer installer contract", () => {
  it("builds a one-click x64 setup that installs TDL before opening user pairing", () => {
    const iss = read("installer/PesoWise-for-Tally-Setup.iss");
    expect(iss).toContain("OutputBaseFilename=PesoWise-Tally-Setup");
    expect(iss).toContain("ArchitecturesAllowed=x64");
    expect(iss).toContain("Install-PesoWise-Tally.ps1");
    expect(iss).toContain("Parameters: \"setup\"");
    expect(iss).toContain("runasoriginaluser");
    expect(iss).toContain("Uninstall-PesoWise-User.ps1");
    expect(iss).toContain("Uninstall-PesoWise-Tally.ps1");
  });

  it("installs only the Bootstrap and Load TDL entry points and leaves deliberate User TDL=No intact", () => {
    const installer = read("installer/out/Install-PesoWise-Tally.ps1");
    expect(installer).toContain('$tdlConfigFiles = @("PesoWise-Bootstrap.tdl", "PesoWise-Load.tdl")');
    expect(installer).toContain("User\\s+TDL\\s*=\\s*No");
    expect(installer).toContain("Left $Path unchanged because User TDL=No");
    expect(installer).toContain("Preserved previous TDL");
    expect(installer).not.toContain("Register-ScheduledTask");
  });

  it("keeps staged connector builds out of public downloads and does not delete older artifacts", () => {
    const builder = read("scripts/tally-integration/build-pesowise-sync.mjs");
    expect(builder).toContain('process.argv.includes("--stage-only")');
    expect(builder).toContain("Staged connector and current TDL modules in installer/out (public downloads unchanged).");
    expect(builder).not.toContain("rmSync");
    const setupBuilder = read("scripts/tally-integration/build-setup-installer.mjs");
    expect(setupBuilder).toContain("--stage-only");
    expect(setupBuilder).toContain("PesoWise-Tally-Setup.exe");
    expect(setupBuilder).toContain("Uninstall-PesoWise-User.ps1");
  });

  it("opens setup/status on a manual executable double-click while logon tasks use explicit run", () => {
    const main = read("connector/tally/src/main.ts");
    const startup = read("connector/tally/src/windowsStartup.ts");
    expect(main).toContain("if (isPackagedExecutable()) return \"setup\";");
    expect(startup).toContain('const tr = `"${process.execPath}" run`;');
  });
});
