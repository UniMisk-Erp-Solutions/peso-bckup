import type { FastifyPluginAsync } from "fastify";
import type pg from "pg";
import { z } from "zod";
import { getPool } from "../db/pool.js";
import { requireAuth, requireRoles } from "../middleware/auth.js";
import { canReadExpense } from "../services/access.js";
import type { AppConfig } from "../config.js";

async function setAuthUid(client: pg.PoolClient, userId: string): Promise<void> {
  await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId]);
}

export const expenseRoutes = (config: AppConfig): FastifyPluginAsync => {
  return async (app) => {
    app.get(
      "/api/expenses",
      { preHandler: requireAuth },
      async (req) => {
        const user = req.authUser!;
        const pool = getPool(config);
        const limit = z.coerce.number().min(1).max(100).default(25).parse(
          (req.query as { limit?: string }).limit ?? 25,
        );
        const r = await pool.query(
          `SELECT id, status, total_amount, created_at, user_id
           FROM public.expenses
           WHERE organization_id = $1
           ORDER BY created_at DESC
           LIMIT $2`,
          [user.organizationId, limit],
        );
        return { items: r.rows };
      },
    );

    app.get(
      "/api/expenses/:id",
      { preHandler: requireAuth },
      async (req, reply) => {
        const user = req.authUser!;
        const expenseId = z.string().uuid().parse((req.params as { id: string }).id);
        const pool = getPool(config);
        const client = await pool.connect();
        try {
          if (!(await canReadExpense(client, user, expenseId))) {
            return reply.code(403).send({ error: "forbidden" });
          }
          const r = await client.query(
            `SELECT id, status, total_amount, user_id, organization_id, created_at
             FROM public.expenses WHERE id = $1`,
            [expenseId],
          );
          if (!r.rows[0]) return reply.code(404).send({ error: "not_found" });
          return { expense: r.rows[0] };
        } finally {
          client.release();
        }
      },
    );

    app.get(
      "/api/admin/users",
      { preHandler: requireRoles(["admin"]) },
      async () => ({ items: [] }),
    );

    app.post(
      "/api/expenses/:id/review/verify",
      { preHandler: requireRoles(["admin", "engineer", "employee"]) },
      async (req, reply) => {
        const user = req.authUser!;
        const expenseId = z.string().uuid().parse((req.params as { id: string }).id);
        const body = z.object({ note: z.string().optional() }).parse(req.body ?? {});
        const pool = getPool(config);
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await setAuthUid(client, user.id);
          const allowed = await client.query<{ ok: boolean }>(
            `SELECT public.reviewer_can_act_on_expense($1) AS ok`,
            [expenseId],
          );
          if (!allowed.rows[0]?.ok) {
            await client.query("ROLLBACK");
            return reply.code(403).send({ error: "forbidden" });
          }
          await client.query(`SELECT public.review_verify_expense($1, $2)`, [
            expenseId,
            body.note ?? "",
          ]);
          await client.query("COMMIT");
          return { ok: true };
        } catch (e) {
          await client.query("ROLLBACK");
          throw e;
        } finally {
          client.release();
        }
      },
    );

    app.post(
      "/api/expenses/:id/review/approve",
      { preHandler: requireRoles(["admin", "engineer"]) },
      async (req, reply) => {
        const user = req.authUser!;
        const expenseId = z.string().uuid().parse((req.params as { id: string }).id);
        const pool = getPool(config);
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await setAuthUid(client, user.id);
          const allowed = await client.query<{ ok: boolean }>(
            `SELECT public.reviewer_can_act_on_expense($1) AS ok`,
            [expenseId],
          );
          if (!allowed.rows[0]?.ok) {
            await client.query("ROLLBACK");
            return reply.code(403).send({ error: "forbidden" });
          }
          const r = await client.query(
            `SELECT public.review_approve_expense($1::uuid, $2::text) AS result`,
            [expenseId, null],
          );
          await client.query("COMMIT");
          return { result: r.rows[0]?.result ?? null };
        } catch (e) {
          await client.query("ROLLBACK");
          throw e;
        } finally {
          client.release();
        }
      },
    );

    app.post(
      "/api/expenses/:id/review/reject",
      { preHandler: requireRoles(["admin", "engineer"]) },
      async (req, reply) => {
        const user = req.authUser!;
        const expenseId = z.string().uuid().parse((req.params as { id: string }).id);
        const body = z.object({ reason: z.string().optional() }).parse(req.body ?? {});
        const pool = getPool(config);
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await setAuthUid(client, user.id);
          await client.query(`SELECT public.review_reject_expense($1, $2)`, [
            expenseId,
            body.reason ?? "",
          ]);
          await client.query("COMMIT");
          return { ok: true };
        } catch (e) {
          await client.query("ROLLBACK");
          throw e;
        } finally {
          client.release();
        }
      },
    );

    app.post(
      "/api/expenses/:id/submit",
      { preHandler: requireAuth },
      async (req, reply) => {
        const user = req.authUser!;
        const expenseId = z.string().uuid().parse((req.params as { id: string }).id);
        const pool = getPool(config);
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await setAuthUid(client, user.id);
          await client.query(`SELECT public.submit_expense($1)`, [expenseId]);
          await client.query("COMMIT");
          return { ok: true };
        } catch (e) {
          await client.query("ROLLBACK");
          throw e;
        } finally {
          client.release();
        }
      },
    );
  };
};
