import type { FastifyPluginAsync } from "fastify";
import type pg from "pg";
import { z } from "zod";
import { getPool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import type { AppConfig } from "../config.js";

const ALLOWED_RPC = new Set([
  "review_verify_expense",
  "review_approve_expense",
  "review_reject_expense",
  "reviewer_can_act_on_expense",
  "submit_expense",
]);

async function setAuthUid(client: pg.PoolClient, userId: string): Promise<void> {
  await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId]);
}

export const rpcRoutes = (config: AppConfig): FastifyPluginAsync => {
  return async (app) => {
    app.post(
      "/api/rpc/:name",
      { preHandler: requireAuth },
      async (req, reply) => {
        const name = z.string().parse((req.params as { name: string }).name);
        if (!ALLOWED_RPC.has(name)) {
          return reply.code(403).send({ error: "rpc_forbidden" });
        }
        const args = (req.body ?? {}) as Record<string, unknown>;
        const user = req.authUser!;
        const pool = getPool(config);
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await setAuthUid(client, user.id);
          if (name === "review_verify_expense") {
            const expenseId = z.string().uuid().parse(args.p_expense_id ?? args.expense_id ?? args.id);
            const note = String(args.p_note ?? args.note ?? "");
            const allowed = await client.query<{ ok: boolean }>(
              `SELECT public.reviewer_can_act_on_expense($1) AS ok`,
              [expenseId],
            );
            if (!allowed.rows[0]?.ok) {
              await client.query("ROLLBACK");
              return reply.code(403).send({ error: "forbidden" });
            }
            await client.query(`SELECT public.review_verify_expense($1, $2)`, [expenseId, note]);
            await client.query("COMMIT");
            return { ok: true };
          }
          if (name === "review_approve_expense") {
            const expenseId = z.string().uuid().parse(args.p_expense_id ?? args.expense_id ?? args.id);
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
          }
          if (name === "review_reject_expense") {
            const expenseId = z.string().uuid().parse(args.p_expense_id ?? args.expense_id ?? args.id);
            const reason = String(args.p_reason ?? args.reason ?? "");
            await client.query(`SELECT public.review_reject_expense($1, $2)`, [expenseId, reason]);
            await client.query("COMMIT");
            return { ok: true };
          }
          if (name === "submit_expense") {
            const expenseId = z.string().uuid().parse(args.p_expense_id ?? args.expense_id ?? args.id);
            await client.query(`SELECT public.submit_expense($1)`, [expenseId]);
            await client.query("COMMIT");
            return { ok: true };
          }
          if (name === "reviewer_can_act_on_expense") {
            const expenseId = z.string().uuid().parse(args.p_expense_id ?? args.expense_id ?? args.id);
            const r = await client.query(`SELECT public.reviewer_can_act_on_expense($1) AS ok`, [expenseId]);
            await client.query("COMMIT");
            return { ok: r.rows[0]?.ok ?? false };
          }
          await client.query("ROLLBACK");
          return reply.code(400).send({ error: "unimplemented_rpc" });
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
