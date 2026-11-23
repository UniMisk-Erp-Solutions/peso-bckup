/** True when running as pkg-produced PesoWiseConnector.exe (not node dist/main.js). */
export function isPackagedExecutable(): boolean {
  return typeof (process as NodeJS.Process & { pkg?: { entrypoint?: string } }).pkg !== "undefined";
}

export function isProductionConnectorRuntime(): boolean {
  return isPackagedExecutable() || process.env.PESOWISE_CONNECTOR_PRODUCTION === "1";
}
