import { randomUUID } from "node:crypto";

/** RFC 4122 v4 UUID — Node crypto (pkg snapshot safe; no globalThis.crypto). */
export function newInstallationId(): string {
  return randomUUID();
}
