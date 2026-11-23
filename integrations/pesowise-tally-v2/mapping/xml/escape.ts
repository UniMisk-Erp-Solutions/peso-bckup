/** XML 1.0 text escaping — safe for user-provided PesoWise fields. */
export function escapeXmlText(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function escapeXmlAttr(value: unknown): string {
  return escapeXmlText(value);
}
