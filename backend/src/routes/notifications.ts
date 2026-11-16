import type { FastifyPluginAsync } from "fastify";
import { getPool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import type { AppConfig } from "../config.js";

export const notificationRoutes = (config: AppConfig): FastifyPluginAsync => {
  return async (app) => {
    app.get("/api/notifications", { preHandler: requireAuth }, async (req) => {
      const user = req.authUser!;
      const pool = getPool(config);
      const r = await pool.query(
        `SELECT id, title, message, read, created_at, type
         FROM public.notifications
         WHERE user_id = $1 AND organization_id = $2
         ORDER BY created_at DESC
         LIMIT 100`,
        [user.id, user.organizationId],
      );
      return { items: r.rows };
    });

    app.patch("/api/notifications/:id/read", { preHandler: requireAuth }, async (req, reply) => {
      const user = req.authUser!;
      const id = (req.params as { id: string }).id;
      const pool = getPool(config);
      const r = await pool.query(
        `UPDATE public.notifications SET read = true
         WHERE id = $1 AND user_id = $2 AND organization_id = $3
         RETURNING id`,
        [id, user.id, user.organizationId],
      );
      if (!r.rowCount) return reply.code(404).send({ error: "not_found" });
      return { ok: true };
    });
  };
};
