import { connect } from "node:net";

/** Doctor: one TCP probe, no HTTP/XML to Tally. */
export const DOCTOR_TALLY_TCP_TIMEOUT_MS = 3_000;

/** Agent idle loop: one TCP probe before claim/delivery. */
export const AGENT_TALLY_TCP_TIMEOUT_MS = 3_000;

/**
 * Single-shot TCP connect — no retry, no fallback, no Tally XML.
 * Returns false on timeout, error, or immediate close.
 */
export function checkTcpPort(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };

    const socket = connect({ host, port });
    socket.setTimeout(timeoutMs);

    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}
