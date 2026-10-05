/**
 * MicroLink expense snapshot — the ONE object a submit sends.
 *
 * The old architecture sent an expense through three independent network
 * mutations: INSERT/UPDATE expenses, then a custom-field RPC, then a PATCH that
 * flipped the status. The first two committed on their own, so when the
 * submission guard refused the third the expense was left as a draft with its
 * core row already durable. That is the 2026-09-08 incident.
 *
 * Here the entire expense becomes ONE immutable object, built once, and sent
 * once. Two rules make that safe, and both are enforced by tests:
 *
 *   1. A value the employee can SEE must appear in the snapshot. Silently
 *      omitting a visible field is the exact failure we are removing, so
 *      omission is a thrown error, never a quiet skip.
 *
 *   2. The snapshot may only be built from RESOLVED configuration. If the
 *      branch config for the selected project has not loaded, we do not guess
 *      what is applicable — we refuse to build.
 *
 * The client deliberately does NOT send template ids or branch ids for the
 * MicroLink fields. It sends business values; the server owns the mapping.
 */

export const MICROLINK_ORGANIZATION_ID = "6709c1fe-e8c8-404d-bc68-d1edda923344";

/** Categories are configured per-organization; these drive client-side UX only. */
export interface MicroLinkFieldVisibility {
  projectUniqueId: boolean;
  fromLocation: boolean;
  toLocation: boolean;
}

export interface MicroLinkFormState {
  expenseId?: string | null;
  expectedRevision?: number | null;

  title: string;
  destination: string;
  /** ISO yyyy-mm-dd. */
  tripStart: string;
  tripEnd?: string | null;
  category: string;
  totalAmount: number | string;
  purpose?: string | null;

  projectUniqueId?: string | null;
  /** Only sent when the project genuinely offers a choice; otherwise derived. */
  projectId?: string | null;
  projectName?: string | null;
  fromLocation?: string | null;
  toLocation?: string | null;

  /** Any other template the form rendered for this category. */
  additionalFields?: { templateId: string; value: string | null }[];
}

export interface MicroLinkExpenseSnapshotV1 {
  idempotency_key: string;
  expense_id?: string;
  expected_revision?: number;
  core: {
    title: string;
    destination: string;
    trip_start: string;
    trip_end?: string;
    category: string;
    total_amount: number;
    purpose?: string;
  };
  microlink: {
    project_unique_id?: string;
    project_id?: string;
    project_name?: string;
    from_location?: string;
    to_location?: string;
  };
  additional_fields: { template_id: string; value: string }[];
}

export class SnapshotNotReadyError extends Error {
  readonly reason: "unresolved_config" | "missing_visible_value";
  readonly field: string;
  constructor(reason: SnapshotNotReadyError["reason"], field: string, message: string) {
    super(message);
    this.name = "SnapshotNotReadyError";
    this.reason = reason;
    this.field = field;
  }
}

function clean(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const s = String(value).trim();
  return s === "" ? undefined : s;
}

function toAmount(value: number | string): number {
  const n = typeof value === "number" ? value : Number(String(value).replace(/[₹,\s]/g, ""));
  if (!Number.isFinite(n)) {
    throw new SnapshotNotReadyError("missing_visible_value", "total_amount",
      "Amount is not a valid number.");
  }
  return n;
}

/**
 * Build the snapshot. Throws rather than shipping an incomplete object.
 *
 * `visibility` says which MicroLink fields this category actually shows, and
 * `configResolved` says whether the selected project's branch configuration has
 * finished loading. Both come from the form, and both are required: a field
 * that is visible and filled must reach the server, and a field whose
 * applicability is still unknown must not be guessed at.
 */
export function buildMicroLinkExpenseSnapshotV1(
  form: MicroLinkFormState,
  options: {
    idempotencyKey: string;
    visibility: MicroLinkFieldVisibility;
    /** False while the selected project's branch config is still loading. */
    configResolved: boolean;
  },
): MicroLinkExpenseSnapshotV1 {
  const { idempotencyKey, visibility, configResolved } = options;

  if (!configResolved) {
    // The precise failure the old client had: an unresolved fetch was
    // indistinguishable from "this project has no extra fields", so it computed
    // an empty set and dropped everything.
    throw new SnapshotNotReadyError("unresolved_config", "project_unique_id",
      "Project details are still loading. Please wait a moment and submit again.");
  }

  const title = clean(form.title);
  const destination = clean(form.destination);
  const tripStart = clean(form.tripStart);
  const category = clean(form.category);

  for (const [field, value] of Object.entries({ title, destination, trip_start: tripStart, category })) {
    if (!value) {
      throw new SnapshotNotReadyError("missing_visible_value", field,
        `${field.replace(/_/g, " ")} is required.`);
    }
  }

  const microlink: MicroLinkExpenseSnapshotV1["microlink"] = {};

  // A visible MicroLink field that the employee filled MUST travel. This loop
  // is the guarantee; the tests below it are what stop a future edit removing a
  // field from the payload without anyone noticing.
  if (visibility.projectUniqueId) {
    const uid = clean(form.projectUniqueId);
    if (!uid) {
      throw new SnapshotNotReadyError("missing_visible_value", "project_unique_id",
        "Project Unique ID is required.");
    }
    microlink.project_unique_id = uid;
    // Only forwarded when present. When the project has a single legal value the
    // server derives it, and a stale client value is refused rather than used.
    const pid = clean(form.projectId);
    if (pid) microlink.project_id = pid;
    const pname = clean(form.projectName);
    if (pname) microlink.project_name = pname;
  }

  if (visibility.fromLocation) {
    const from = clean(form.fromLocation);
    if (!from) {
      throw new SnapshotNotReadyError("missing_visible_value", "from_location",
        "From location is required.");
    }
    microlink.from_location = from;
  }

  if (visibility.toLocation) {
    const to = clean(form.toLocation);
    if (!to) {
      throw new SnapshotNotReadyError("missing_visible_value", "to_location",
        "To location is required.");
    }
    microlink.to_location = to;
  }

  const additional = (form.additionalFields ?? [])
    .map((f) => ({ template_id: f.templateId, value: clean(f.value) }))
    .filter((f): f is { template_id: string; value: string } => f.value !== undefined);

  const snapshot: MicroLinkExpenseSnapshotV1 = {
    idempotency_key: idempotencyKey,
    core: {
      title: title!,
      destination: destination!,
      trip_start: tripStart!,
      category: category!,
      total_amount: toAmount(form.totalAmount),
    },
    microlink,
    additional_fields: additional,
  };

  const tripEnd = clean(form.tripEnd);
  if (tripEnd) snapshot.core.trip_end = tripEnd;
  const purpose = clean(form.purpose);
  if (purpose) snapshot.core.purpose = purpose;
  const expenseId = clean(form.expenseId);
  if (expenseId) snapshot.expense_id = expenseId;
  if (typeof form.expectedRevision === "number") {
    snapshot.expected_revision = form.expectedRevision;
  }

  // Frozen: no React effect can mutate a snapshot after it is built. The old
  // architecture read core state at one moment and custom-field state at
  // another, which is how a superseded project's values could travel.
  Object.freeze(snapshot.core);
  Object.freeze(snapshot.microlink);
  Object.freeze(snapshot.additional_fields);
  return Object.freeze(snapshot);
}

/**
 * Every business value the employee can see, flattened. Used by the round-trip
 * test to compare form -> snapshot -> database without hand-listing fields, so
 * a newly added field is covered automatically.
 */
export function visibleBusinessValues(
  form: MicroLinkFormState,
  visibility: MicroLinkFieldVisibility,
): Record<string, string> {
  const out: Record<string, string> = {};
  const put = (k: string, v: unknown) => {
    const c = clean(v);
    if (c !== undefined) out[k] = c;
  };
  put("title", form.title);
  put("destination", form.destination);
  put("trip_start", form.tripStart);
  put("category", form.category);
  put("total_amount", String(toAmount(form.totalAmount)));
  put("purpose", form.purpose);
  if (visibility.projectUniqueId) {
    put("project_unique_id", form.projectUniqueId);
    put("project_id", form.projectId);
    put("project_name", form.projectName);
  }
  if (visibility.fromLocation) put("from_location", form.fromLocation);
  if (visibility.toLocation) put("to_location", form.toLocation);
  for (const f of form.additionalFields ?? []) put(`template:${f.templateId}`, f.value);
  return out;
}

/** The same flattening, applied to a built snapshot. */
export function snapshotBusinessValues(
  snapshot: MicroLinkExpenseSnapshotV1,
): Record<string, string> {
  const out: Record<string, string> = {};
  out.title = snapshot.core.title;
  out.destination = snapshot.core.destination;
  out.trip_start = snapshot.core.trip_start;
  out.category = snapshot.core.category;
  out.total_amount = String(snapshot.core.total_amount);
  if (snapshot.core.purpose) out.purpose = snapshot.core.purpose;
  for (const [k, v] of Object.entries(snapshot.microlink)) {
    if (v) out[k] = v;
  }
  for (const f of snapshot.additional_fields) out[`template:${f.template_id}`] = f.value;
  return out;
}

/* -------------------------------------------------------------------------- */
/* Bridge: ExpenseForm's internal state -> the serializer's input.             */
/*                                                                            */
/* Kept pure and separate so the mapping is unit-testable without mounting a   */
/* 5,000-line form, and so ExpenseForm's own edit stays small.                 */
/* -------------------------------------------------------------------------- */

/** The MicroLink templates, addressed by their configured display name. */
export const MICROLINK_TEMPLATE_NAMES = {
  projectUniqueId: "Project Unique ID",
  fromLocation: "From location",
  toLocation: "To location",
} as const;

export interface CategoryFormFieldLike {
  template?: {
    id?: string;
    name?: string;
    field_type?: string;
    required?: boolean;
  } | null;
  required?: boolean | null;
}

export interface OptionBranchLike {
  id?: string;
  field_key?: string;
  parent_option_value?: string;
}

/**
 * Read the MicroLink business values straight out of the form's own state.
 *
 * Crucially this reads ONCE, from the caller's already-frozen view of state.
 * The old architecture read core state at one moment and custom-field state at
 * another, which is how a superseded project's values could travel.
 */
export function microLinkFormStateFromExpenseForm(input: {
  core: Pick<MicroLinkFormState,
    "expenseId" | "expectedRevision" | "title" | "destination" | "tripStart" |
    "tripEnd" | "category" | "totalAmount" | "purpose">;
  categoryFormFields: CategoryFormFieldLike[];
  /** templateId -> value */
  formFieldValues: Record<string, string>;
  /** branchId -> value */
  branchValues: Record<string, string>;
  optionBranches: OptionBranchLike[];
}): { form: MicroLinkFormState; visibility: MicroLinkFieldVisibility } {
  const byName = new Map<string, string>();
  for (const f of input.categoryFormFields) {
    const id = f.template?.id;
    const name = f.template?.name;
    if (id && name) byName.set(name, id);
  }

  const templateValue = (name: string): string | undefined => {
    const id = byName.get(name);
    return id ? input.formFieldValues[id] : undefined;
  };

  const uidTemplateId = byName.get(MICROLINK_TEMPLATE_NAMES.projectUniqueId);
  const selectedUid = uidTemplateId ? input.formFieldValues[uidTemplateId] : undefined;

  // Branch values for the CURRENTLY selected project only. A branch belonging
  // to a project the employee has moved away from must not travel.
  const branchValueFor = (fieldKey: string): string | undefined => {
    if (!selectedUid) return undefined;
    const branch = input.optionBranches.find(
      (b) => b.field_key === fieldKey && b.parent_option_value === selectedUid,
    );
    return branch?.id ? input.branchValues[branch.id] : undefined;
  };

  const visibility: MicroLinkFieldVisibility = {
    projectUniqueId: byName.has(MICROLINK_TEMPLATE_NAMES.projectUniqueId),
    fromLocation: byName.has(MICROLINK_TEMPLATE_NAMES.fromLocation),
    toLocation: byName.has(MICROLINK_TEMPLATE_NAMES.toLocation),
  };

  // Anything else this category rendered travels as a plain template value.
  const known = new Set<string>(Object.values(MICROLINK_TEMPLATE_NAMES));
  const additionalFields = input.categoryFormFields
    .filter((f) => f.template?.name && !known.has(f.template.name))
    .map((f) => ({
      templateId: f.template!.id as string,
      value: input.formFieldValues[f.template!.id as string] ?? null,
    }))
    .filter((f) => !!f.templateId);

  return {
    visibility,
    form: {
      ...input.core,
      projectUniqueId: selectedUid,
      projectId: branchValueFor("project_id"),
      projectName: branchValueFor("project_name"),
      fromLocation: templateValue(MICROLINK_TEMPLATE_NAMES.fromLocation),
      toLocation: templateValue(MICROLINK_TEMPLATE_NAMES.toLocation),
      additionalFields,
    },
  };
}
