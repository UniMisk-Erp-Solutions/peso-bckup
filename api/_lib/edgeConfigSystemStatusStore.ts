/**
 * Edge Config-backed SystemStatusStore implementation.
 * In production/Vercel: NEVER silently falls back to in-memory store.
 * In local development: in-memory fallback is allowed only when explicitly permitted.
 * Server-only. Do NOT import into the Vite client bundle.
 */

import type { SystemStatusStore, StoreReadResult, StoreWriteResult } from "./systemStatusStore.js";
import { applyWrite } from "./systemStatusStore.js";
import type { MaintenanceWritePayload, SystemStatusDocument } from "./systemStatusTypes.js";
import { defaultStatusDocument } from "./systemStatusTypes.js";
import { isMemoryStorePermitted, getSystemStatusEnvironmentDiagnostics } from "./systemStatusEnvironment.js";
import {
  resolveEdgeConfigWriteConfig,
  buildEdgeConfigWriteUrl,
  mapProviderError,
} from "./edgeConfigWriteConfig.js";

const EDGE_CONFIG_KEY = "system_status";

export type SystemStatusStoreDiagnostics = {
  provider: "edge_config" | "memory" | "unavailable";
  readable: boolean;
  writable: boolean;
  configurationState:
    | "ready"
    | "missing_read_configuration"
    | "missing_write_configuration"
    | "package_unavailable"
    | "invalid_connection"
    | "read_failed";
  missingVariables: string[];
};

/** Shape Edge Config actually returns — the value might be any JSON */
type EdgeConfigClient = {
  get(key: string): Promise<unknown>;
};

function isSystemStatusDocument(v: unknown): v is SystemStatusDocument {
  if (!v || typeof v !== "object") return false;
  const d = v as Record<string, unknown>;
  return d.schema_version === 1 && typeof d.revision === "string";
}

async function readViaClient(
  client: EdgeConfigClient,
): Promise<SystemStatusDocument | null> {
  try {
    const value = await client.get(EDGE_CONFIG_KEY);
    if (isSystemStatusDocument(value)) return value;
    return null;
  } catch {
    return null;
  }
}

async function writeViaRestApi(doc: SystemStatusDocument): Promise<void> {
  const configResult = resolveEdgeConfigWriteConfig();
  if (!configResult.ok) {
    throw new Error(
      `maintenance_store_not_configured: missing ${configResult.missingVariables.join(", ")}`,
    );
  }

  const { config } = configResult;
  const url = buildEdgeConfigWriteUrl(config);

  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      items: [{ operation: "upsert", key: EDGE_CONFIG_KEY, value: doc }],
    }),
  });

  if (!res.ok) {
    // Consume and discard the raw provider body — never forward it to callers.
    await res.text().catch(() => {});
    const safeErr = mapProviderError(res.status);
    throw new Error(safeErr.message);
  }
}

export class EdgeConfigSystemStatusStore implements SystemStatusStore {
  private client: EdgeConfigClient;

  constructor(client: EdgeConfigClient) {
    this.client = client;
  }

  async read(): Promise<StoreReadResult> {
    try {
      const doc = await readViaClient(this.client);
      return { ok: true, doc: doc ?? defaultStatusDocument() };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Edge Config read failed: ${msg}` };
    }
  }

  async write(
    payload: MaintenanceWritePayload,
    serverNow: Date,
  ): Promise<StoreWriteResult> {
    const env = getSystemStatusEnvironmentDiagnostics();
    if (!env.writeReady) {
      return {
        ok: false,
        error: `maintenance_store_not_configured: missing ${env.missingWriteVars.join(", ")}`,
      };
    }

    const readResult = await this.read();
    if (!readResult.ok) {
      return { ok: false, error: readResult.error };
    }

    const applyResult = applyWrite(readResult.doc, payload, serverNow);
    if ("error" in applyResult) {
      return { ok: false, error: applyResult.error, conflict: applyResult.conflict };
    }

    try {
      await writeViaRestApi(applyResult.doc);
      return { ok: true, doc: applyResult.doc };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  }
}

/**
 * Unavailable store returned when Edge Config is not configured in production.
 * All reads return a safe unknown state; all writes return 503.
 */
export class UnavailableSystemStatusStore implements SystemStatusStore {
  private readonly reason: string;

  constructor(reason: string) {
    this.reason = reason;
  }

  async read(): Promise<StoreReadResult> {
    // Return a safe unknown state — never throw, never return HTML
    return {
      ok: true,
      doc: {
        ...defaultStatusDocument(),
        revision: "unconfigured",
      },
    };
  }

  async write(_payload: MaintenanceWritePayload, _serverNow: Date): Promise<StoreWriteResult> {
    return { ok: false, error: `maintenance_store_not_configured: ${this.reason}` };
  }
}

/**
 * Build the best available store for the current environment.
 *
 * Production / Vercel Preview:
 *   - Requires EDGE_CONFIG env var
 *   - Never falls back to in-memory (state must survive cold starts)
 *   - Returns UnavailableSystemStatusStore with diagnostics if unconfigured
 *
 * Local development:
 *   - May use in-memory store when ALLOW_MEMORY_STATUS_STORE=1 or NODE_ENV !== production
 *   - Clearly labeled as non-persistent
 */
export async function buildSystemStatusStore(): Promise<SystemStatusStore> {
  const connectionString = process.env.EDGE_CONFIG;

  if (connectionString) {
    try {
      const { createClient } = await import("@vercel/edge-config");
      const client = createClient(connectionString);
      return new EdgeConfigSystemStatusStore(client);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[system-status] @vercel/edge-config import failed:", msg);

      // In production/Vercel: fail loudly — do NOT silently lose state
      if (!isMemoryStorePermitted()) {
        return new UnavailableSystemStatusStore(
          `@vercel/edge-config unavailable: ${msg}`,
        );
      }

      // Local dev: warn and fall through
      console.warn("[system-status] Falling back to non-persistent memory store (dev only)");
    }
  } else {
    if (!isMemoryStorePermitted()) {
      // Production without EDGE_CONFIG: return safe unavailable store
      console.error("[system-status] EDGE_CONFIG not set in production — maintenance state cannot persist");
      return new UnavailableSystemStatusStore("EDGE_CONFIG env var not set");
    }
    console.warn(
      "[system-status] EDGE_CONFIG not set; using non-persistent memory store (dev only). State will reset on cold start.",
    );
  }

  // Local development fallback only
  const { InMemorySystemStatusStore } = await import("./systemStatusStore.js");
  const store = new InMemorySystemStatusStore();
  console.warn(
    "[system-status] Using IN-MEMORY store (non-persistent, local development only). " +
    "Set EDGE_CONFIG to enable persistent storage.",
  );
  return store;
}

export function getStoreDiagnostics(store: SystemStatusStore): SystemStatusStoreDiagnostics {
  const env = getSystemStatusEnvironmentDiagnostics();
  if (store instanceof EdgeConfigSystemStatusStore) {
    return {
      provider: "edge_config",
      readable: env.readReady,
      writable: env.writeReady,
      configurationState: env.writeReady ? "ready" : "missing_write_configuration",
      missingVariables: [...env.missingWriteVars],
    };
  }
  if (store instanceof UnavailableSystemStatusStore) {
    const allMissing = [...env.missingReadVars, ...env.missingWriteVars];
    return {
      provider: "unavailable",
      readable: false,
      writable: false,
      configurationState: env.missingReadVars.length > 0
        ? "missing_read_configuration"
        : "missing_write_configuration",
      missingVariables: allMissing,
    };
  }
  // InMemorySystemStatusStore
  return {
    provider: "memory",
    readable: true,
    writable: true,
    configurationState: "ready",
    missingVariables: [],
  };
}
