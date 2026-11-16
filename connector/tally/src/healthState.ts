import { mkdirSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export type ConnectorHealthSnapshot = {
  updated_at: string;
  agent_version: string;
  connector_paired: boolean;
  organization_id: string | null;
  tally_reachable: boolean;
  tally_company_name: string | null;
  last_delivery_batch_id: string | null;
  last_delivery_ok: boolean | null;
  last_error_safe: string | null;
};

const HEALTH_PATH = join(homedir(), "PesoWise", "TallyConnector", "health.json");

export function healthStatePath(): string {
  return HEALTH_PATH;
}

export function writeHealthSnapshot(snapshot: ConnectorHealthSnapshot): void {
  mkdirSync(join(homedir(), "PesoWise", "TallyConnector"), { recursive: true });
  writeFileSync(HEALTH_PATH, JSON.stringify(snapshot, null, 2), "utf-8");
}
