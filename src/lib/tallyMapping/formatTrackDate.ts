/** DD-MM-YYYY — same as PesoWise export tables. */
export function formatTrackDateForTally(iso: unknown): string {
  const raw = String(iso ?? "").trim();
  const d = raw.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return raw;
  const [y, m, day] = d.split("-");
  return `${day}-${m}-${y}`;
}
