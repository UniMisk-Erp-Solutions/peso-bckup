/** Single customer agent — setup once, then only use Sync in PesoWise. */
export const PESOWISE_SYNC_EXE = "/downloads/PesoWiseSync.exe";

export function pesoWiseTallyConnectUrl(pairingCode: string): string {
  return `pesowise-tally://${pairingCode.trim().toUpperCase()}`;
}
