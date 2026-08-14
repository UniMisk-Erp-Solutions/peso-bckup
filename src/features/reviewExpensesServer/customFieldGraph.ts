/**
 * Conditional custom-field graph (DOC-080 §3–§4).
 *
 * The bug this replaces: the filter row rendered one dropdown per branch
 * definition, so an organization with ten "Project ID" branches under different
 * parents showed ten identical "Project ID" controls. Branch definitions are a
 * TREE, not a list — a child is only meaningful once its parent has the value
 * that reveals it.
 *
 * Visibility rule, applied recursively:
 *
 *   root templates            -> always visible
 *   branch with parent_template_id -> visible iff that template's selected value
 *                                     equals parent_option_value
 *   branch with parent_branch_id   -> visible iff that branch is itself visible
 *                                     AND its selected value equals
 *                                     parent_option_value
 *
 * Two branches sharing a label but sitting under different parents are never
 * both visible, because a single-select parent can only hold one value.
 */

import type { ReviewCustomFilter, ReviewFilterField } from "@/features/reviewQueueServer/types";

/** Stable identity for one server field. Never the label. */
export function customFieldKey(source: string, fieldId: string): string {
  return `${source}:${fieldId}`;
}

export function fieldKeyOf(f: ReviewFilterField): string {
  return customFieldKey(f.source, f.field_id);
}

/** `Record<key, value>` (what the shared UI speaks) -> server predicates. */
export function valuesToCustomFilters(values: Record<string, string>): ReviewCustomFilter[] {
  return Object.entries(values)
    .filter(([, v]) => String(v ?? "").trim() !== "")
    .map(([key, value]) => {
      const [source, ...rest] = key.split(":");
      return {
        source: source === "branch" ? "branch" : "template",
        field_id: rest.join(":"),
        values: [value],
      } as ReviewCustomFilter;
    })
    .filter((f) => f.field_id.length > 0);
}

export function customFiltersToValues(filters: ReviewCustomFilter[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of filters) {
    if (f.values.length > 0) out[customFieldKey(f.source, f.field_id)] = f.values[0];
  }
  return out;
}

/** Direct children of a field, keyed by the parent value that reveals them. */
function childrenOf(fields: ReviewFilterField[], parent: ReviewFilterField): ReviewFilterField[] {
  if (parent.source === "template") {
    return fields.filter((f) => f.source === "branch" && f.parent_template_id === parent.field_id);
  }
  return fields.filter((f) => f.source === "branch" && f.parent_branch_id === parent.field_id);
}

/**
 * The fields that should currently be on screen, parents before children.
 *
 * A child appears only when its parent holds exactly the value that declares it,
 * so the count grows one control at a time as the reviewer drills down — never
 * ten at once.
 */
export function visibleFields(
  fields: ReviewFilterField[],
  values: Record<string, string>,
): ReviewFilterField[] {
  const roots = fields
    .filter((f) => f.source === "template")
    .sort((a, b) => a.display_order - b.display_order || (a.label ?? "").localeCompare(b.label ?? ""));

  const out: ReviewFilterField[] = [];
  const seen = new Set<string>();

  const walk = (field: ReviewFilterField, depth: number) => {
    const key = fieldKeyOf(field);
    // Guard against a malformed cycle in the stored metadata.
    if (seen.has(key) || depth > 10) return;
    seen.add(key);
    out.push(field);

    const selected = values[key];
    if (!selected) return;

    childrenOf(fields, field)
      .filter((c) => c.parent_option_value === selected)
      .sort((a, b) => a.display_order - b.display_order || (a.label ?? "").localeCompare(b.label ?? ""))
      .forEach((c) => walk(c, depth + 1));
  };

  roots.forEach((r) => walk(r, 0));
  return out;
}

/** Every descendant key of a field, regardless of current selection. */
export function descendantKeys(
  fields: ReviewFilterField[],
  field: ReviewFilterField,
  depth = 0,
  seen = new Set<string>(),
): string[] {
  if (depth > 10) return [];
  const out: string[] = [];
  for (const child of childrenOf(fields, field)) {
    const key = fieldKeyOf(child);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
    out.push(...descendantKeys(fields, child, depth + 1, seen));
  }
  return out;
}

/**
 * Applies one selection and drops everything it invalidates.
 *
 * Changing or clearing a parent must clear its descendants — leaving them would
 * send a predicate for a control the reviewer can no longer see, silently
 * narrowing results with no visible cause.
 */
export function applySelection(
  fields: ReviewFilterField[],
  values: Record<string, string>,
  key: string,
  value: string,
): Record<string, string> {
  const field = fields.find((f) => fieldKeyOf(f) === key);
  const next = { ...values };

  if (field) {
    for (const dead of descendantKeys(fields, field)) delete next[dead];
  }

  if (!value || value.trim() === "") delete next[key];
  else next[key] = value;

  // Anything no longer on screen must not reach the server.
  return pruneHidden(fields, next);
}

/** Drops values for fields that are not currently visible. */
export function pruneHidden(
  fields: ReviewFilterField[],
  values: Record<string, string>,
): Record<string, string> {
  const visible = new Set(visibleFields(fields, values).map(fieldKeyOf));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) {
    if (visible.has(k)) out[k] = v;
  }
  return out;
}

/** Counts for diagnostics and tests: how much the tree actually collapses. */
export function fieldCounts(fields: ReviewFilterField[], values: Record<string, string>) {
  return {
    templates: fields.filter((f) => f.source === "template").length,
    branches: fields.filter((f) => f.source === "branch").length,
    visible: visibleFields(fields, values).length,
  };
}
