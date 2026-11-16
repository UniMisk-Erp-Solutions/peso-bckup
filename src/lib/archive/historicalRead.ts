import { supabase } from "@/integrations/supabase/client";

/** Explicit historical read — not used by default expense lists. */
export async function fetchArchivedExpensesPage(params: {
  organizationId: string;
  dateFrom: string;
  dateTo: string;
  pageSize?: number;
  cursor?: string | null;
}) {
  const { data, error } = await supabase.rpc("get_archived_expenses_v1", {
    p_organization_id: params.organizationId,
    p_date_from: params.dateFrom,
    p_date_to: params.dateTo,
    p_page_size: params.pageSize ?? 25,
    p_cursor: params.cursor ?? null,
  });
  if (error) throw error;
  return data;
}

export async function previewArchiveBatch(params: {
  tableName: string;
  organizationId: string;
  cutoffDate: string;
  limit?: number;
}) {
  const { data, error } = await supabase.rpc("preview_archive_batch_v1", {
    p_table_name: params.tableName,
    p_organization_id: params.organizationId,
    p_cutoff_date: params.cutoffDate,
    p_limit: params.limit ?? 1000,
  });
  if (error) throw error;
  return data;
}
