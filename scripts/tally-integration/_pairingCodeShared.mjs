import crypto from "node:crypto";

export const SMOKE_ADMIN_USER = "7316914e-f8a8-49cb-808f-f549a56e668d";
export const SMOKE_ORG = "80ab039f-f9e2-4c76-8b5b-e65b15d66af9";
export const TALLY_COMPANY = "PesoWise Integration Test";

/** Same opaque eight-character pairing code shape as the smoke issuer. */
export function generatePairingCodePlaintext() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
}
