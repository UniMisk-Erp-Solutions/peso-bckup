import type { FastifyPluginAsync } from "fastify";
import { getPool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import type { AppConfig } from "../config.js";

export const dashboardRoutes = (config: AppConfig): FastifyPluginAsync => {
  return async (app) => {
    app.get("/api/dashboard/summary", { preHandler: requireAuth }, async (req) => {
      const user = req.authUser!;
      const pool = getPool(config);
      const org = user.organizationId;
      const [exp, unread, balance] = await Promise.all([
        pool.query(
          `SELECT count(*)::int AS total FROM public.expenses WHERE organization_id = $1`,
          [org],
        ),
        pool.query(
          `SELECT count(*)::int AS unread FROM public.notifications
           WHERE user_id = $1 AND organization_id = $2 AND read = false`,
          [user.id, org],
        ),
        pool.query(
          `SELECT coalesce(balance, 0)::float AS balance FROM public.profiles
           WHERE id = $1 OR user_id = $1 LIMIT 1`,
          [user.id],
        ),
      ]);
      return {
        expenseCount: exp.rows[0]?.total ?? 0,
        unreadNotifications: unread.rows[0]?.unread ?? 0,
        balance: balance.rows[0]?.balance ?? 0,
      };
    });
  };
};
