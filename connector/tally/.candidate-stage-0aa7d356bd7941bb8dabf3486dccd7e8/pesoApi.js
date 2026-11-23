"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PesoConnectorApi = void 0;
exports.exchangePairingCode = exchangePairingCode;
class PesoConnectorApi {
    baseUrl;
    deviceToken;
    constructor(baseUrl, deviceToken) {
        this.baseUrl = baseUrl;
        this.deviceToken = deviceToken;
    }
    async post(action, body = {}) {
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
        let json;
        try {
            json = JSON.parse(text);
        }
        catch {
            throw new Error(`PesoWise API invalid JSON (${res.status})`);
        }
        if (!res.ok) {
            throw new Error(`PesoWise API ${res.status}: ${JSON.stringify(json).slice(0, 200)}`);
        }
        return json;
    }
    async heartbeat(version) {
        return this.post("heartbeat", { version });
    }
    async claim(expectedCompanyName) {
        return (await this.post("claim", { expected_company_name: expectedCompanyName }));
    }
    async claimBound(jobId, batchId, expectedCompanyName) {
        return (await this.post("claim", {
            job_id: jobId,
            batch_id: batchId,
            lease_seconds: 120,
            expected_company_name: expectedCompanyName,
        }));
    }
    async jobBatches(jobId) {
        return (await this.post("job_batches", { job_id: jobId }));
    }
    async ack(params) {
        return this.post("ack", params);
    }
}
exports.PesoConnectorApi = PesoConnectorApi;
async function exchangePairingCode(supabaseUrl, anonKey, pairingCode, deviceName, installationId, version) {
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
    let json;
    try {
        json = text ? JSON.parse(text) : {};
    }
    catch {
        throw new Error(`Pairing response not JSON (${res.status}): ${text.slice(0, 200)}`);
    }
    if (res.status === 401) {
        const msg = json.message ?? "Unauthorized";
        throw new Error(`${msg} — Supabase gateway rejected the anon JWT for ${supabaseUrl}. ` +
            `Use scripts/tally-integration/resolve-backup-anon-key.mjs (PRINT_ANON_KEY=1) for this stack; ` +
            `do not use a key from a different Supabase project.`);
    }
    if (!res.ok)
        throw new Error(JSON.stringify(json).slice(0, 300));
    return json;
}
