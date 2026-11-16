export type ClaimResult =
  | { claimed: false }
  | {
      claimed: true;
      batch_id: string;
      job_id: string;
      batch_index: number;
      message_count: number;
      xml: string;
      tally_company_name: string | null;
      delivery_updates?: unknown[];
    };

export class PesoConnectorApi {
  constructor(
    private baseUrl: string,
    private deviceToken: string,
  ) {}

  private async post(action: string, body: Record<string, unknown> = {}) {
    const url = `${this.baseUrl.replace(/\/$/, "")}/functions/v1/tally-connector`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Connector-Token": this.deviceToken,
      },
      body: JSON.stringify({ action, ...body }),
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`PesoWise API invalid JSON (${res.status})`);
    }
    if (!res.ok) {
      throw new Error(`PesoWise API ${res.status}: ${JSON.stringify(json).slice(0, 200)}`);
    }
    return json as Record<string, unknown>;
  }

  async heartbeat(version: string) {
    return this.post("heartbeat", { version });
  }

  async claim(expectedCompanyName: string): Promise<ClaimResult> {
    return (await this.post("claim", { expected_company_name: expectedCompanyName })) as ClaimResult;
  }

  async claimBound(jobId: string, batchId: string, expectedCompanyName: string): Promise<ClaimResult> {
    return (await this.post("claim", {
      job_id: jobId,
      batch_id: batchId,
      lease_seconds: 120,
      expected_company_name: expectedCompanyName,
    })) as ClaimResult;
  }

  async jobBatches(jobId: string): Promise<{
    job_id: string;
    batches: Array<{ id: string; status: string; batch_index: number; message_count: number }>;
  }> {
    const pageSize = 1000;
    const maxBatchRows = 100_000;
    const batches: Array<{ id: string; status: string; batch_index: number; message_count: number }> = [];
    let totalCount: number | null = null;
    for (let offset = 0; offset < maxBatchRows; offset += pageSize) {
      const page = await this.post("job_batches", { job_id: jobId, offset, limit: pageSize }) as {
        job_id?: string;
        total_count?: number;
        batches?: Array<{ id: string; status: string; batch_index: number; message_count: number }>;
      };
      if (page.job_id !== jobId || !Array.isArray(page.batches)) {
        throw new Error("PesoWise API returned an invalid job batch page");
      }
      if (Number.isSafeInteger(page.total_count) && Number(page.total_count) >= 0) {
        totalCount = Number(page.total_count);
      }
      batches.push(...page.batches);
      if (totalCount !== null && batches.length >= totalCount) {
        return { job_id: jobId, batches };
      }
      if (page.batches.length < pageSize) {
        return { job_id: jobId, batches };
      }
      if (totalCount === null) {
        throw new Error("PesoWise API does not support complete job batch pagination");
      }
    }
    if (totalCount !== null && batches.length < totalCount) {
      throw new Error(`PesoWise job has more than ${maxBatchRows} delivery batches`);
    }
    return { job_id: jobId, batches };
  }

  async ack(params: {
    batch_id: string;
    success: boolean;
    ack_summary?: Record<string, unknown>;
    tally_response_safe?: string;
    error_safe?: string;
    delivery_updates?: unknown[];
  }) {
    return this.post("ack", params);
  }
}

export async function exchangePairingCode(
  supabaseUrl: string,
  anonKey: string,
  pairingCode: string,
  deviceName: string,
  installationId: string,
  version: string,
) {
  const url = `${supabaseUrl.replace(/\/$/, "")}/rest/v1/rpc/exchange_tally_connector_pairing_v1`;
  const headers = {
    apikey: anonKey,
    Authorization: `Bearer ${anonKey}`,
    "Content-Type": "application/json",
  };
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      p_pairing_code: pairingCode,
      p_device_name: deviceName,
      p_installation_id: installationId,
      p_connector_version: version,
    }),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Pairing response not JSON (${res.status}): ${text.slice(0, 200)}`);
  }
  if (res.status === 401) {
    const msg = (json as { message?: string }).message ?? "Unauthorized";
    throw new Error(
      `${msg} — Supabase gateway rejected the anon JWT for ${supabaseUrl}. ` +
        `Use scripts/tally-integration/resolve-backup-anon-key.mjs (PRINT_ANON_KEY=1) for this stack; ` +
        `do not use a key from a different Supabase project.`,
    );
  }
  if (!res.ok) throw new Error(JSON.stringify(json).slice(0, 300));
  return json as {
    connector_id: string;
    organization_id: string;
    device_token: string;
  };
}
