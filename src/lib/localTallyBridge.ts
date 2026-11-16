/** Local dev bridge (auto-started with `npm run dev`) — delivers Sync jobs to TallyPrime. */
export const LOCAL_TALLY_BRIDGE_URL =
  import.meta.env.VITE_TALLY_LOCAL_BRIDGE_URL ?? "http://127.0.0.1:9876";

export type LocalTallyBridgeHealth = {
  ok?: boolean;
  connector_paired?: boolean;
  organization_id?: string | null;
  tally_reachable?: boolean;
  tally_company_name?: string | null;
  tally_company_verified?: boolean;
  tally_company_verified_name?: string | null;
  delivery_in_progress?: boolean;
  metadata_import_ready?: boolean | null;
  /** False when port 9000 responds but no company is loaded for HTTP import. */
  tally_company_on_http?: boolean | null;
};

export async function fetchLocalTallyBridgeHealth(): Promise<LocalTallyBridgeHealth | null> {
  try {
    const res = await fetch(`${LOCAL_TALLY_BRIDGE_URL}/v1/health`, { method: "GET" });
    if (!res.ok) return null;
    return (await res.json()) as LocalTallyBridgeHealth;
  } catch {
    return null;
  }
}

export function localTallyBridgeMatches(
  health: LocalTallyBridgeHealth | null,
  organizationId: string,
  companyName: string,
): boolean {
  return Boolean(
    health?.ok === true &&
    health.connector_paired === true &&
    health.organization_id === organizationId &&
    health.tally_company_verified === true &&
    health.tally_company_verified_name === companyName &&
    health.tally_company_name === companyName &&
    health.metadata_import_ready === true,
  );
}

export async function isLocalTallyBridgeUp(): Promise<boolean> {
  const h = await fetchLocalTallyBridgeHealth();
  return h?.ok === true;
}

/** Mirror org Tally company name into local connector config.json (used on deliver). */
export async function pushLocalTallyCompanyName(tallyCompanyName: string): Promise<boolean> {
  const trimmed = tallyCompanyName.trim();
  if (!trimmed) return false;
  try {
    const res = await fetch(`${LOCAL_TALLY_BRIDGE_URL}/v1/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tally_company_name: trimmed }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function requestLocalTallyDeliverJob(jobId: string): Promise<boolean> {
  try {
    const res = await fetch(`${LOCAL_TALLY_BRIDGE_URL}/v1/deliver-job`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ job_id: jobId }),
    });
    if (res.status === 202 || res.ok) return true;
    if (res.status === 409) {
      try {
        const body = (await res.json()) as { error?: string; job_id?: string };
        if (body.error === "delivery_in_progress") {
          return !body.job_id || body.job_id === jobId;
        }
      } catch {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}
