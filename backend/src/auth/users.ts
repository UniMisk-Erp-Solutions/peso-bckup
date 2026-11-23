import bcrypt from "bcrypt";
import type pg from "pg";

export type AuthUser = {
  id: string;
  email: string;
  roles: string[];
  organizationId: string | null;
};

export async function findUserByEmail(
  client: pg.PoolClient,
  email: string,
): Promise<{ id: string; encryptedPassword: string } | null> {
  const r = await client.query<{ id: string; encrypted_password: string }>(
    `SELECT u.id, u.encrypted_password
     FROM auth.users u
     LEFT JOIN auth.identities i ON i.user_id = u.id AND i.provider = 'email'
     WHERE lower(coalesce(u.email, i.identity_data->>'email')) = lower($1)
     LIMIT 1`,
    [email],
  );
  const row = r.rows[0];
  if (!row?.encrypted_password) return null;
  return { id: row.id, encryptedPassword: row.encrypted_password };
}

export async function verifyPassword(
  plain: string,
  encryptedPassword: string,
): Promise<boolean> {
  if (encryptedPassword.startsWith("$2")) {
    return bcrypt.compare(plain, encryptedPassword);
  }
  return false;
}

export async function loadAuthUser(
  client: pg.PoolClient,
  userId: string,
): Promise<AuthUser | null> {
  const u = await client.query<{ id: string; email: string }>(
    `SELECT u.id, coalesce(u.email, i.identity_data->>'email') AS email
     FROM auth.users u
     LEFT JOIN auth.identities i ON i.user_id = u.id AND i.provider = 'email'
     WHERE u.id = $1
     LIMIT 1`,
    [userId],
  );
  const base = u.rows[0];
  if (!base) return null;
  const rolesR = await client.query<{ role: string }>(
    `SELECT role::text AS role FROM public.user_roles WHERE user_id = $1`,
    [userId],
  );
  const orgR = await client.query<{ organization_id: string | null }>(
    `SELECT coalesce(
       (SELECT p.organization_id FROM public.profiles p WHERE p.id = $1),
       (
         SELECT om.organization_id
         FROM public.organization_memberships om
         WHERE om.user_id = $1 AND om.organization_id IS NOT NULL
         ORDER BY om.joined_at NULLS LAST
         LIMIT 1
       ),
       (
         SELECT e.organization_id
         FROM public.expenses e
         WHERE e.user_id = $1 AND e.organization_id IS NOT NULL
         ORDER BY e.created_at DESC
         LIMIT 1
       ),
       (
         SELECT a.organization_id
         FROM public.attachments a
         WHERE a.uploaded_by = $1 AND a.organization_id IS NOT NULL
         ORDER BY a.created_at DESC
         LIMIT 1
       )
     ) AS organization_id`,
    [userId],
  );
  let organizationId = orgR.rows[0]?.organization_id ?? null;
  const roles = rolesR.rows.map((x) => x.role);
  if (!organizationId && roles.some((r) => r === "admin" || r === "master_admin")) {
    const legacy = await client.query<{ organization_id: string | null }>(
      `SELECT organization_id
       FROM public.expenses
       WHERE organization_id IS NOT NULL
       ORDER BY created_at DESC
       LIMIT 1`,
    );
    organizationId = legacy.rows[0]?.organization_id ?? null;
  }
  if (!organizationId) {
    if (roles.some((r) => r === "admin" || r === "master_admin")) {
      const singleTenant = await client.query<{ organization_id: string | null }>(
        `SELECT id AS organization_id FROM public.organizations ORDER BY created_at NULLS LAST LIMIT 2`,
      );
      if (singleTenant.rowCount === 1 && singleTenant.rows[0]?.organization_id) {
        organizationId = singleTenant.rows[0].organization_id;
      }
    }
  }
  return {
    id: base.id,
    email: base.email ?? "",
    roles: rolesR.rows.map((x) => x.role),
    organizationId,
  };
}

export function hasRole(user: AuthUser, allowed: string[]): boolean {
  return user.roles.some((r) => allowed.includes(r));
}
