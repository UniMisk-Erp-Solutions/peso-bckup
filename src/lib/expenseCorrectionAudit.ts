import { format } from "date-fns";
import { formatINR, parseLocalDate } from "@/lib/format";

export type ExpenseCorrectionLogEntry = {
  id: string;
  created_at: string;
  edited_by: string;
  reason: string | null;
  before_json: unknown;
  after_json: unknown;
};

type CorrectionSnapshot = Record<string, unknown>;

const FIELD_LABELS: Record<string, string> = {
  title: "Title",
  destination: "Destination",
  category: "Category",
  total_amount: "Amount",
  purpose: "Purpose",
  admin_comment: "Admin comment",
  trip_date: "Date of expense",
};

const AUDIT_SCALAR_KEYS = [
  "title",
  "destination",
  "category",
  "total_amount",
  "purpose",
  "admin_comment",
] as const;

function snapshotToRecord(json: unknown): CorrectionSnapshot {
  if (json && typeof json === "object" && !Array.isArray(json)) {
    return json as CorrectionSnapshot;
  }
  return {};
}

function normalizeCompare(value: string): string {
  return value.trim().toLowerCase();
}

function emptyDisplay(value: unknown): boolean {
  return value === null || value === undefined || value === "";
}

function formatDateValue(value: unknown): string {
  if (emptyDisplay(value)) return "—";
  const parsed = parseLocalDate(String(value));
  if (!parsed) return String(value);
  return format(parsed, "MMM d, yyyy");
}

function formatExpenseDate(snapshot: CorrectionSnapshot): string {
  const start = snapshot.trip_start;
  const end = snapshot.trip_end;
  const startStr = formatDateValue(start);
  const endStr = formatDateValue(end);
  if (startStr === "—" && endStr === "—") return "—";
  if (startStr !== "—" && startStr === endStr) return startStr;
  if (startStr !== "—" && endStr !== "—") return `${startStr} – ${endStr}`;
  return startStr !== "—" ? startStr : endStr;
}

export function formatCorrectionFieldValue(key: string, value: unknown): string {
  if (key === "total_amount") {
    if (emptyDisplay(value)) return "—";
    const num = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(num)) return "—";
    return formatINR(num);
  }
  if (key === "trip_start" || key === "trip_end" || key === "trip_date") {
    return formatDateValue(value);
  }
  if (emptyDisplay(value)) return "—";
  return String(value).trim();
}

export type CorrectionFieldChange = {
  key: string;
  label: string;
  before: string;
  after: string;
};

export function getCorrectionChanges(
  beforeJson: unknown,
  afterJson: unknown,
): CorrectionFieldChange[] {
  const before = snapshotToRecord(beforeJson);
  const after = snapshotToRecord(afterJson);
  const changes: CorrectionFieldChange[] = [];

  const dateBefore = formatExpenseDate(before);
  const dateAfter = formatExpenseDate(after);
  if (normalizeCompare(dateBefore) !== normalizeCompare(dateAfter)) {
    changes.push({
      key: "trip_date",
      label: FIELD_LABELS.trip_date,
      before: dateBefore,
      after: dateAfter,
    });
  }

  for (const key of AUDIT_SCALAR_KEYS) {
    const beforeVal = formatCorrectionFieldValue(key, before[key]);
    const afterVal = formatCorrectionFieldValue(key, after[key]);
    if (normalizeCompare(beforeVal) !== normalizeCompare(afterVal)) {
      changes.push({
        key,
        label: FIELD_LABELS[key] ?? key,
        before: beforeVal,
        after: afterVal,
      });
    }
  }

  return changes;
}
