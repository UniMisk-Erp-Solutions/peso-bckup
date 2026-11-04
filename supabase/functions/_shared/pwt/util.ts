/** Small pure helpers for the pwt engine. */

export function norm(s: unknown): string {
  return String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Parses "1,234.50", "₹ 1234", "(120)" -> number; NaN when not numeric. */
export function parseAmount(v: unknown): number {
  if (typeof v === "number") return v;
  if (v == null) return NaN;
  let s = String(v).trim();
  if (!s) return NaN;
  let neg = false;
  if (/^\(.*\)$/.test(s)) {
    neg = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/[^\d.\-]/g, "");
  if (!s || s === "-" || s === ".") return NaN;
  const n = Number(s);
  return neg ? -n : n;
}

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Accepts yyyy-mm-dd, yyyy-mm-ddT..., dd-mm-yyyy, dd/mm/yyyy -> ISO yyyy-mm-dd or "" */
export function toIsoDate(v: unknown): string {
  const s = String(v ?? "").trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  let y: number, mo: number, d: number;
  if (m) {
    y = +m[1]; mo = +m[2]; d = +m[3];
  } else if ((m = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/.exec(s))) {
    d = +m[1]; mo = +m[2]; y = +m[3];
  } else return "";
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return "";
  return `${String(y).padStart(4, "0")}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function monthStart(iso: string): string {
  const [y, m] = iso.split("-").map(Number);
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-01`;
}

export function monthEnd(iso: string): string {
  const [y, m] = iso.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(last).padStart(2, "0")}`;
}

/** yyyy-mm-dd -> yyyymmdd (Tally date) */
export function tallyDate(iso: string): string {
  return iso.replace(/-/g, "");
}

export function xmlEscape(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    // strip characters illegal in XML 1.0
    // deno-lint-ignore no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}

export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
}

/** sha-256 hex using WebCrypto (Deno, Node >= 19, browsers). */
export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function pick(row: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    const v = row[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}
