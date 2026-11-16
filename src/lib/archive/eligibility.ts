/**
 * Pure helpers for archive eligibility (mirrors DB policy concepts; no I/O).
 */

export type ArchiveTier = "hot" | "warm" | "cold";

export function isTerminalStatus(
  status: string,
  requireTerminal: boolean,
  terminalValues: string[],
): boolean {
  if (!requireTerminal) return true;
  if (!terminalValues.length) return false;
  return terminalValues.includes(status);
}

export function resolveTier(
  ageMonths: number,
  hotMonths: number,
  warmMonths: number,
  coldMonths: number | null,
): ArchiveTier {
  if (ageMonths <= hotMonths) return "hot";
  if (ageMonths <= warmMonths) return "warm";
  if (coldMonths != null && ageMonths <= coldMonths) return "cold";
  return "cold";
}

export function monthsBetween(older: Date, newer: Date): number {
  const years = newer.getFullYear() - older.getFullYear();
  const months = newer.getMonth() - older.getMonth();
  return years * 12 + months;
}
