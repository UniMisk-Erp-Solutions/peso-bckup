/**
 * DOC-097 hotfix — service layer for the option-scoped server-paged Form
 * Field Template RPCs (20260820200000_form_template_server_pagination.sql,
 * 20260820210000_form_template_option_summary_and_create.sql):
 *
 *   search_form_template_parent_options
 *   get_form_template_parent_option_configuration
 *   save_parent_option_branch_configuration_atomically
 *   get_form_template_editor_summary
 *   create_form_template_parent_option
 *
 * The browser never owns the full template configuration snapshot: opening
 * the editor fetches a tiny summary, browsing/searching fetches one page of
 * cheap per-option aggregates, and opening a specific option fetches only
 * that option's own branch tree. The existing V1 service
 * (`@/lib/optionBranchPersistence`) is untouched and remains available for
 * brand-new (unsaved) templates, which have no id to search against yet.
 */
import { supabase } from "@/integrations/supabase/client";
import type { BranchFieldType } from "@/lib/conditionalFormFieldTypes";
import { slugifyFieldKey } from "@/lib/conditionalFormFields";

// ─── Bounded request timeout ─────────────────────────────────────────────────
//
// Every RPC in this file is wrapped so a hung request surfaces as a clear,
// retryable error instead of spinning forever — and NEVER falls back to
// downloading the full unpaginated dataset.

export const SERVER_REQUEST_TIMEOUT_MS = 20_000;

export class ServerRequestTimeoutError extends Error {
  constructor(label: string) {
    super(`${label} took too long. Retry.`);
    this.name = "ServerRequestTimeoutError";
  }
}

function withTimeout<T>(promise: Promise<T>, label: string, ms = SERVER_REQUEST_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ServerRequestTimeoutError(label)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

// ─── Search ──────────────────────────────────────────────────────────────────

export type IntegrityStatus = "not_applicable" | "complete" | "incomplete";

export type ParentOptionSearchResult = {
  optionValue: string;
  displayIndex: number;
  activeRootBranchCount: number;
  activeTotalBranchCount: number;
  configured: boolean;
  integrityStatus: IntegrityStatus;
  previewFields: PreviewField[];
};

/** One lightweight display value from an option's own root branches (up to
 *  2, server-selected). `value` follows the schema's own authoritative
 *  display convention -- e.g. for Project Unique ID, `value` is the sole
 *  entry of a single-option select branch (options=["17828"]), never a
 *  guessed column. */
export type PreviewField = {
  fieldKey: string;
  name: string;
  value: string | null;
};

export type SearchPage = {
  results: ParentOptionSearchResult[];
  page: number;
  pageSize: number;
  totalResults: number;
  totalPages: number;
  hasPrevious: boolean;
  hasNext: boolean;
};

type PreviewFieldRpcRow = {
  field_key: string;
  name: string;
  value: string | null;
};

type SearchRpcRow = {
  option_value: string;
  display_index: number;
  active_root_branch_count: number;
  active_total_branch_count: number;
  configured: boolean;
  integrity_status: IntegrityStatus;
  preview_fields: PreviewFieldRpcRow[];
};

type SearchRpcResponse = {
  results: SearchRpcRow[];
  page: number;
  page_size: number;
  total_results: number;
  total_pages: number;
  has_previous: boolean;
  has_next: boolean;
};

/**
 * Server-side search + pagination over a template's parent options. Never
 * downloads branch definitions — only cheap per-option aggregates. Caller
 * is responsible for only invoking this on an explicit Search action (Enter
 * or the Search button), never on every keystroke — see useServerPagedOptionSearch.
 */
export async function searchFormTemplateParentOptions(
  organizationId: string,
  templateId: string,
  query: string | null,
  page: number,
  pageSize: number,
  configuredOnly = false,
): Promise<SearchPage> {
  const { data, error } = await withTimeout(
    supabase.rpc("search_form_template_parent_options", {
      p_organization_id: organizationId,
      p_template_id: templateId,
      p_query: query && query.trim() !== "" ? query.trim() : null,
      p_page: page,
      p_page_size: pageSize,
      p_configured_only: configuredOnly,
    }),
    "Search",
  );

  if (error) throw error;
  const r = data as SearchRpcResponse;

  return {
    results: (r.results ?? []).map((row) => ({
      optionValue: row.option_value,
      displayIndex: row.display_index,
      activeRootBranchCount: row.active_root_branch_count,
      activeTotalBranchCount: row.active_total_branch_count,
      configured: row.configured,
      integrityStatus: row.integrity_status,
      previewFields: (row.preview_fields ?? []).map((f) => ({
        fieldKey: f.field_key,
        name: f.name,
        value: f.value,
      })),
    })),
    page: r.page,
    pageSize: r.page_size,
    totalResults: r.total_results,
    totalPages: r.total_pages,
    hasPrevious: r.has_previous,
    hasNext: r.has_next,
  };
}

// ─── On-demand option configuration ─────────────────────────────────────────

/** Same draft shape the V1 editor uses, so OptionBranchEditor can be reused unchanged. */
export type DraftOptionBranchV2 = {
  localId: string;
  dbId: string | null;
  parent_option_value: string;
  parent_branch_local_id: string | null;
  field_key: string;
  name: string;
  field_type: BranchFieldType;
  required: boolean;
  placeholder: string;
  help_text: string;
  options: string[];
  display_order: number;
};

export type OptionConfiguration = {
  parentOptionValue: string;
  drafts: DraftOptionBranchV2[];
  configurationFingerprint: string;
};

type BranchConfigRow = {
  db_id: string;
  parent_branch_id: string | null;
  parent_option_value: string;
  field_key: string;
  name: string;
  field_type: BranchFieldType;
  required: boolean;
  placeholder: string | null;
  help_text: string | null;
  options: string[] | null;
  display_order: number;
};

type OptionConfigRpcResponse = {
  parent_option_value: string;
  branches: BranchConfigRow[];
  configuration_fingerprint: string;
};

export function createDraftBranchV2(
  parentOptionValue: string,
  parentBranchLocalId: string | null,
  displayOrder: number,
): DraftOptionBranchV2 {
  const localId = crypto.randomUUID();
  return {
    localId,
    dbId: null,
    parent_option_value: parentOptionValue,
    parent_branch_local_id: parentBranchLocalId,
    field_key: `field_${localId.slice(0, 8)}`,
    name: "",
    field_type: "text",
    required: false,
    placeholder: "",
    help_text: "",
    options: [],
    display_order: displayOrder,
  };
}

/**
 * Fetches exactly one parent option's full branch tree (root + all nested
 * descendants) plus a content fingerprint used for optimistic concurrency
 * on save. Downloads nothing about any other option.
 */
export async function getFormTemplateParentOptionConfiguration(
  organizationId: string,
  templateId: string,
  parentOptionValue: string,
): Promise<OptionConfiguration> {
  const { data, error } = await withTimeout(
    supabase.rpc("get_form_template_parent_option_configuration", {
      p_organization_id: organizationId,
      p_template_id: templateId,
      p_parent_option_value: parentOptionValue,
    }),
    "Loading this option",
  );

  if (error) throw error;
  const r = data as OptionConfigRpcResponse;

  const idToLocal = new Map<string, string>();
  const raw = r.branches ?? [];
  for (const row of raw) idToLocal.set(row.db_id, crypto.randomUUID());

  const drafts: DraftOptionBranchV2[] = raw.map((row) => ({
    localId: idToLocal.get(row.db_id)!,
    dbId: row.db_id,
    parent_option_value: row.parent_option_value,
    parent_branch_local_id: row.parent_branch_id ? (idToLocal.get(row.parent_branch_id) ?? null) : null,
    field_key: row.field_key,
    name: row.name,
    field_type: row.field_type,
    required: row.required,
    placeholder: row.placeholder ?? "",
    help_text: row.help_text ?? "",
    options: Array.isArray(row.options) ? row.options.map(String) : [],
    display_order: row.display_order,
  }));

  return {
    parentOptionValue: r.parent_option_value,
    drafts,
    configurationFingerprint: r.configuration_fingerprint,
  };
}

// ─── Option-scoped atomic save ──────────────────────────────────────────────

type BranchRpcItemV2 = {
  local_id: string;
  db_id: string | null;
  parent_option_value: string;
  parent_local_id: string | null;
  field_key: string;
  name: string;
  field_type: BranchFieldType;
  required: boolean;
  placeholder: string | null;
  help_text: string | null;
  options: string[] | null;
  display_order: number;
};

export type OptionSaveResult = {
  ok: true;
  revisionId: string;
  parentOptionValue: string;
  branchesInserted: number;
  branchesUpdated: number;
  branchesRetired: number;
};

/**
 * Saves ONE parent option's branch configuration atomically. Structurally
 * cannot affect any other parent option of this template — see the
 * migration's v_existing_ids scoping. Pass expectedFingerprint = null only
 * for a brand-new option with zero existing branches (skips the
 * stale-configuration check, mirroring V1's null-expected-updated-at
 * convention for new rows).
 */
function toBranchRpcPayload(drafts: DraftOptionBranchV2[]): BranchRpcItemV2[] {
  return drafts
    .filter((d) => d.name.trim() !== "")
    .map((d) => ({
      local_id: d.localId,
      db_id: d.dbId ?? null,
      parent_option_value: d.parent_option_value.trim(),
      parent_local_id: d.parent_branch_local_id,
      field_key: d.field_key.trim() || slugifyFieldKey(d.name),
      name: d.name.trim(),
      field_type: d.field_type,
      required: d.required,
      placeholder: d.placeholder || null,
      help_text: d.help_text || null,
      options:
        d.field_type === "select" || d.field_type === "checkbox"
          ? d.options.filter((o) => o.trim() !== "")
          : null,
      display_order: d.display_order,
    }));
}

export async function saveParentOptionBranchConfigurationAtomically(
  organizationId: string,
  templateId: string,
  parentOptionValue: string,
  expectedFingerprint: string | null,
  drafts: DraftOptionBranchV2[],
  source = "category_management_v2",
  reason?: string,
): Promise<OptionSaveResult> {
  const payload = toBranchRpcPayload(drafts);

  const { data, error } = await withTimeout(
    supabase.rpc("save_parent_option_branch_configuration_atomically", {
      p_organization_id: organizationId,
      p_template_id: templateId,
      p_parent_option_value: parentOptionValue,
      p_expected_fingerprint: expectedFingerprint,
      p_branches: payload,
      p_source: source,
      p_reason: reason ?? null,
    }),
    "Saving",
  );

  if (error) throw error;
  const r = data as {
    ok: true;
    revision_id: string;
    parent_option_value: string;
    branches_inserted: number;
    branches_updated: number;
    branches_retired: number;
  };

  return {
    ok: true,
    revisionId: r.revision_id,
    parentOptionValue: r.parent_option_value,
    branchesInserted: r.branches_inserted,
    branchesUpdated: r.branches_updated,
    branchesRetired: r.branches_retired,
  };
}

// ─── Editor summary ──────────────────────────────────────────────────────────

export type TemplateEditorSummary = {
  parentOptionCount: number;
  configuredParentOptionCount: number;
  activeRootBranchCount: number;
  activeNestedBranchCount: number;
  totalActiveBranchCount: number;
  incompleteOptionCount: number;
  legacyOrphanGroupCount: number;
  templateUpdatedAt: string;
};

type SummaryRpcResponse = {
  parent_option_count: number;
  configured_parent_option_count: number;
  active_root_branch_count: number;
  active_nested_branch_count: number;
  total_active_branch_count: number;
  incomplete_option_count: number;
  legacy_orphan_group_count: number;
  template_updated_at: string;
};

/**
 * One tiny aggregate response for the editor's header badges. Never
 * downloads the options array or any branch row.
 */
export async function getFormTemplateEditorSummary(
  organizationId: string,
  templateId: string,
): Promise<TemplateEditorSummary> {
  const { data, error } = await withTimeout(
    supabase.rpc("get_form_template_editor_summary", {
      p_organization_id: organizationId,
      p_template_id: templateId,
    }),
    "Loading summary",
  );

  if (error) throw error;
  const r = data as SummaryRpcResponse;

  return {
    parentOptionCount: r.parent_option_count,
    configuredParentOptionCount: r.configured_parent_option_count,
    activeRootBranchCount: r.active_root_branch_count,
    activeNestedBranchCount: r.active_nested_branch_count,
    totalActiveBranchCount: r.total_active_branch_count,
    incompleteOptionCount: r.incomplete_option_count,
    legacyOrphanGroupCount: r.legacy_orphan_group_count,
    templateUpdatedAt: r.template_updated_at,
  };
}

// ─── Add parent option ───────────────────────────────────────────────────────

export type CreateParentOptionResult = {
  ok: true;
  optionValue: string;
  displayIndex: number;
  parentOptionCount: number;
};

/**
 * Appends exactly one value to the template's options[] array, server-side.
 * Throws with a friendly message on a case-insensitive duplicate (error code
 * P0003 from create_form_template_parent_option) — callers should surface
 * `error.message` directly rather than a raw Postgres error.
 */
export async function createFormTemplateParentOption(
  organizationId: string,
  templateId: string,
  optionValue: string,
): Promise<CreateParentOptionResult> {
  const { data, error } = await withTimeout(
    supabase.rpc("create_form_template_parent_option", {
      p_organization_id: organizationId,
      p_template_id: templateId,
      p_option_value: optionValue,
    }),
    "Adding option",
  );

  if (error) throw error;
  const r = data as { ok: true; option_value: string; display_index: number; parent_option_count: number };

  return {
    ok: true,
    optionValue: r.option_value,
    displayIndex: r.display_index,
    parentOptionCount: r.parent_option_count,
  };
}

export type RenameParentOptionResult = {
  ok: true;
  oldValue: string;
  newValue: string;
  branchesUpdated: number;
};

/** UI-parity fix: scoped equivalent of main's inline Parent Options rename.
 *  Updates options[] and cascades to that option's own root branches only. */
export async function renameFormTemplateParentOption(
  organizationId: string,
  templateId: string,
  oldValue: string,
  newValue: string,
): Promise<RenameParentOptionResult> {
  const { data, error } = await withTimeout(
    supabase.rpc("rename_form_template_parent_option", {
      p_organization_id: organizationId,
      p_template_id: templateId,
      p_old_value: oldValue,
      p_new_value: newValue,
    }),
    "Renaming option",
  );

  if (error) throw error;
  const r = data as { ok: true; old_value: string; new_value: string; branches_updated: number };

  return { ok: true, oldValue: r.old_value, newValue: r.new_value, branchesUpdated: r.branches_updated };
}

export type DeleteParentOptionResult = {
  ok: true;
  deletedValue: string;
  branchesRetired: number;
};

/** UI-parity fix: scoped equivalent of main's Parent Options trash-icon
 *  delete. Removes the option from options[] and retires every branch
 *  under it (root and nested) — never hard-deletes. */
export async function deleteFormTemplateParentOption(
  organizationId: string,
  templateId: string,
  optionValue: string,
): Promise<DeleteParentOptionResult> {
  const { data, error } = await withTimeout(
    supabase.rpc("delete_form_template_parent_option", {
      p_organization_id: organizationId,
      p_template_id: templateId,
      p_option_value: optionValue,
    }),
    "Removing option",
  );

  if (error) throw error;
  const r = data as { ok: true; deleted_value: string; branches_retired: number };

  return { ok: true, deletedValue: r.deleted_value, branchesRetired: r.branches_retired };
}

// ─── Legacy orphan groups (admin, read-only inspection) ─────────────────────

export type OrphanBranchField = {
  fieldKey: string;
  name: string;
  isNested: boolean;
  createdAt: string;
  updatedAt: string;
};

export type OrphanGroup = {
  parentOptionValue: string;
  rootBranchCount: number;
  nestedBranchCount: number;
  fields: OrphanBranchField[];
  earliestCreatedAt: string;
  latestUpdatedAt: string;
};

type OrphanGroupRpcRow = {
  parent_option_value: string;
  root_branch_count: number;
  nested_branch_count: number;
  fields: {
    field_key: string;
    name: string;
    is_nested: boolean;
    created_at: string;
    updated_at: string;
  }[];
  earliest_created_at: string;
  latest_updated_at: string;
};

/**
 * Admin-only, READ-ONLY list of active branch groups whose parent option is
 * no longer in the template's current options[]. No delete/restore/repair
 * capability exists anywhere in this call — inspection only.
 */
export async function getFormTemplateLegacyOrphanGroups(
  organizationId: string,
  templateId: string,
): Promise<OrphanGroup[]> {
  const { data, error } = await withTimeout(
    supabase.rpc("get_form_template_legacy_orphan_groups", {
      p_organization_id: organizationId,
      p_template_id: templateId,
    }),
    "Loading legacy configurations",
  );

  if (error) throw error;
  const r = data as { groups: OrphanGroupRpcRow[] };

  return (r.groups ?? []).map((g) => ({
    parentOptionValue: g.parent_option_value,
    rootBranchCount: g.root_branch_count,
    nestedBranchCount: g.nested_branch_count,
    fields: (g.fields ?? []).map((f) => ({
      fieldKey: f.field_key,
      name: f.name,
      isNested: f.is_nested,
      createdAt: f.created_at,
      updatedAt: f.updated_at,
    })),
    earliestCreatedAt: g.earliest_created_at,
    latestUpdatedAt: g.latest_updated_at,
  }));
}

// ─── Employee-safe runtime search ────────────────────────────────────────────

export type RuntimeSearchResult = {
  optionValue: string;
  previewFields: PreviewField[];
};

type RuntimeSearchRpcRow = {
  option_value: string;
  preview_fields: PreviewFieldRpcRow[];
};

/**
 * Bounded (<=20 results) runtime search for the employee expense-form
 * combobox. Any active org member may call this — not admin-only. Never
 * downloads all options or any branch tree.
 */
export async function searchRuntimeFormTemplateParentOptions(
  organizationId: string,
  templateId: string,
  query: string | null,
  limit = 20,
): Promise<RuntimeSearchResult[]> {
  const { data, error } = await withTimeout(
    supabase.rpc("search_runtime_form_template_parent_options_v1", {
      p_organization_id: organizationId,
      p_template_id: templateId,
      p_query: query && query.trim() !== "" ? query.trim() : null,
      p_limit: limit,
    }),
    "Search projects",
  );

  if (error) throw error;
  const r = data as { results: RuntimeSearchRpcRow[] };

  return (r.results ?? []).map((row) => ({
    optionValue: row.option_value,
    previewFields: (row.preview_fields ?? []).map((f) => ({
      fieldKey: f.field_key,
      name: f.name,
      value: f.value,
    })),
  }));
}

// ─── Recently-used options (own-user-only) ───────────────────────────────────

export type RecentOption = {
  optionValue: string;
  lastUsedAt: string;
  previewFields: PreviewField[];
};

type RecentOptionRpcRow = {
  option_value: string;
  last_used_at: string;
  preview_fields: PreviewFieldRpcRow[];
};

/**
 * The caller's own most-recently-used, distinct, still-active parent option
 * values for this template. Never another employee's history, never
 * cross-org. Clamped server-side to 1-10, default 4.
 */
export async function getMyRecentFormTemplateOptions(
  organizationId: string,
  templateId: string,
  limit = 4,
): Promise<RecentOption[]> {
  const { data, error } = await withTimeout(
    supabase.rpc("get_my_recent_form_template_options_v1", {
      p_organization_id: organizationId,
      p_template_id: templateId,
      p_limit: limit,
    }),
    "Loading recent projects",
  );

  if (error) throw error;
  const r = data as { results: RecentOptionRpcRow[] };

  return (r.results ?? []).map((row) => ({
    optionValue: row.option_value,
    lastUsedAt: row.last_used_at,
    previewFields: (row.preview_fields ?? []).map((f) => ({
      fieldKey: f.field_key,
      name: f.name,
      value: f.value,
    })),
  }));
}

// ─── Batch option configuration (bulk import / Matrix / preset parity) ──────
//
// These two RPCs let the browser fetch/save a BOUNDED SUBSET of a large
// template's parent options in one round trip -- e.g. the ~25 rows on a
// Matrix page, or the option values actually referenced by a bulk import --
// instead of either downloading the whole template or issuing one request
// per option. Every entry saved through the batch RPC still goes through
// save_parent_option_branch_configuration_atomically's own per-option
// scoping unchanged; the batch wrapper only adds "keep going and report
// partial results" around calls that were already individually safe.

/** The server enforces this same cap; kept here so callers can chunk before
 *  the request leaves the browser rather than discovering the limit from a
 *  thrown error. */
export const MAX_OPTION_BATCH_SIZE = 300;

type BatchConfigRpcRow = {
  parent_option_value: string;
  branches: BranchConfigRow[];
  configuration_fingerprint: string | null;
};

/** Splits `values` into chunks of at most `size`, preserving order. */
function chunk<T>(values: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

/**
 * Fetches the branch configuration for a SET of parent option values in
 * bounded batches (chunked to MAX_OPTION_BATCH_SIZE, limited concurrency),
 * never the whole template. A requested value that has zero branches still
 * comes back with an empty drafts array so the caller can tell "exists but
 * unconfigured" apart from "wasn't requested".
 */
export async function getFormTemplateParentOptionConfigurationsBatch(
  organizationId: string,
  templateId: string,
  parentOptionValues: string[],
  concurrency = 3,
): Promise<OptionConfiguration[]> {
  const distinct = Array.from(new Set(parentOptionValues.filter((v) => v.trim() !== "")));
  if (distinct.length === 0) return [];

  const batches = chunk(distinct, MAX_OPTION_BATCH_SIZE);
  const results: OptionConfiguration[] = [];

  for (const group of chunk(batches, concurrency)) {
    const settled = await Promise.all(
      group.map((values) =>
        withTimeout(
          supabase.rpc("get_form_template_parent_option_configurations_batch", {
            p_organization_id: organizationId,
            p_template_id: templateId,
            p_parent_option_values: values,
          }),
          "Loading options",
        ),
      ),
    );
    for (const { data, error } of settled) {
      if (error) throw error;
      const rows = ((data as { configs: BatchConfigRpcRow[] }).configs ?? []);
      for (const row of rows) {
        const idToLocal = new Map<string, string>();
        const raw = row.branches ?? [];
        for (const b of raw) idToLocal.set(b.db_id, crypto.randomUUID());
        const drafts: DraftOptionBranchV2[] = raw.map((b) => ({
          localId: idToLocal.get(b.db_id)!,
          dbId: b.db_id,
          parent_option_value: b.parent_option_value,
          parent_branch_local_id: b.parent_branch_id ? (idToLocal.get(b.parent_branch_id) ?? null) : null,
          field_key: b.field_key,
          name: b.name,
          field_type: b.field_type,
          required: b.required,
          placeholder: b.placeholder ?? "",
          help_text: b.help_text ?? "",
          options: Array.isArray(b.options) ? b.options.map(String) : [],
          display_order: b.display_order,
        }));
        results.push({
          parentOptionValue: row.parent_option_value,
          drafts,
          configurationFingerprint: row.configuration_fingerprint ?? "",
        });
      }
    }
  }

  return results;
}

export type BatchSaveEntry = {
  parentOptionValue: string;
  expectedFingerprint: string | null;
  drafts: DraftOptionBranchV2[];
};

export type BatchSaveEntryResult =
  | {
      parentOptionValue: string;
      status: "ok";
      branchesInserted: number;
      branchesUpdated: number;
      branchesRetired: number;
    }
  | { parentOptionValue: string; status: "error"; errorMessage: string };

export type BatchSaveResult = {
  newOptionsAdded: number;
  results: BatchSaveEntryResult[];
};

type BatchSaveRpcResponse = {
  new_options_added: number;
  results: Array<
    | {
        parent_option_value: string;
        status: "ok";
        branches_inserted: number;
        branches_updated: number;
        branches_retired: number;
      }
    | { parent_option_value: string; status: "error"; error_message: string }
  >;
};

/**
 * Saves MANY parent options' branch configurations in bounded batches.
 * Each option is still fully atomic and option-scoped on its own (the
 * migration calls save_parent_option_branch_configuration_atomically once
 * per entry) -- one option's failure (stale fingerprint, duplicate key,
 * missing required field) never aborts the rest of the batch. New option
 * values not yet on the template are appended once, case-insensitively
 * deduped, ahead of the per-option saves.
 */
export async function saveFormTemplateParentOptionConfigurationsBatchAtomically(
  organizationId: string,
  templateId: string,
  newOptionValues: string[],
  entries: BatchSaveEntry[],
  source = "bulk_import_batch",
  reason?: string,
  concurrency = 3,
): Promise<BatchSaveResult> {
  const groups = chunk(entries, MAX_OPTION_BATCH_SIZE);
  let newOptionsAdded = 0;
  const results: BatchSaveEntryResult[] = [];

  for (const [i, batch] of chunk(groups.map((g, idx) => ({ g, idx })), concurrency).entries()) {
    void i;
    const settled = await Promise.all(
      batch.map(({ g, idx }) =>
        withTimeout(
          // NOTE: this RPC name was originally 64 chars
          // ("...configurations_batch_atomically") -- Postgres's 63-char
          // identifier limit silently truncated it server-side, so the
          // original name never actually worked. Renamed shorter in
          // 20260822130000_fix_batch_save_function_name_truncation.sql.
          supabase.rpc("save_form_template_parent_options_batch_atomically", {
            p_organization_id: organizationId,
            p_template_id: templateId,
            // Only the FIRST chunk carries the new-option-value append --
            // it's a one-time, template-wide operation, not per-chunk.
            p_new_option_values: idx === 0 ? newOptionValues : [],
            p_entries: g.map((e) => ({
              parent_option_value: e.parentOptionValue,
              expected_fingerprint: e.expectedFingerprint,
              branches: toBranchRpcPayload(e.drafts),
            })),
            p_source: source,
            p_reason: reason ?? null,
          }),
          "Saving options",
        ),
      ),
    );
    for (const { data, error } of settled) {
      if (error) throw error;
      const r = data as BatchSaveRpcResponse;
      newOptionsAdded += r.new_options_added ?? 0;
      for (const row of r.results ?? []) {
        if (row.status === "ok") {
          results.push({
            parentOptionValue: row.parent_option_value,
            status: "ok",
            branchesInserted: row.branches_inserted,
            branchesUpdated: row.branches_updated,
            branchesRetired: row.branches_retired,
          });
        } else {
          results.push({
            parentOptionValue: row.parent_option_value,
            status: "error",
            errorMessage: row.error_message,
          });
        }
      }
    }
  }

  return { newOptionsAdded, results };
}
