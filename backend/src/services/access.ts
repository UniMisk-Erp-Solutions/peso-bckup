import type pg from "pg";
import type { AuthUser } from "../auth/users.js";

export async function canReadExpense(
  client: pg.PoolClient,
  user: AuthUser,
  expenseId: string,
): Promise<boolean> {
  if (!user.organizationId) return false;
  const r = await client.query<{ ok: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM public.expenses e
       WHERE e.id = $1
         AND e.organization_id = $2
         AND (
           e.user_id = $3
           OR EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = $3 AND ur.role::text IN ('admin','engineer','cashier'))
         )
     ) AS ok`,
    [expenseId, user.organizationId, user.id],
  );
  return Boolean(r.rows[0]?.ok);
}

export async function canAccessAttachmentKey(
  client: pg.PoolClient,
  user: AuthUser,
  bucket: string,
  objectKey: string,
): Promise<boolean> {
  const r = await client.query<{ ok: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM public.attachments a
       LEFT JOIN public.expenses e ON e.id = a.expense_id
       WHERE coalesce(a.organization_id, e.organization_id) = $2
         AND (
           a.storage_path = $1
           OR a.file_url LIKE '%' || $1 || '%'
         )
         AND (
           coalesce(e.user_id, a.uploaded_by) = $3
           OR EXISTS (
             SELECT 1 FROM public.user_roles ur
             WHERE ur.user_id = $3 AND ur.role::text IN ('admin','engineer','cashier','master_admin')
           )
         )
     ) AS ok`,
    [objectKey, user.organizationId, user.id],
  );
  return Boolean(r.rows[0]?.ok);
}
