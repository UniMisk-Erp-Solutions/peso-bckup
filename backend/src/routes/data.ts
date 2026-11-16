import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { getPool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import type { AppConfig } from "../config.js";

const READ_TABLES = new Set([
  "profiles",
  "organization_memberships",
  "organizations",
  "organization_settings",
  "expenses",
  "expense_line_items",
  "attachments",
  "notifications",
  "user_roles",
  "expense_categories",
  "audit_logs",
  "organization_feature_flags",
]);

const ORG_SCOPED = new Set([
  "expenses",
  "attachments",
  "notifications",
  "audit_logs",
  "expense_line_items",
]);

export const dataRoutes = (config: AppConfig): FastifyPluginAsync => {
  return async (app) => {
    app.get(
      "/api/data/:table",
      { preHandler: requireAuth },
      async (req, reply) => {
        const table = z.string().parse((req.params as { table: string }).table);
        if (!READ_TABLES.has(table)) {
          return reply.code(403).send({ error: "table_forbidden" });
        }
        const user = req.authUser!;
        if (!user.organizationId && ORG_SCOPED.has(table)) {
          return reply.code(403).send({ error: "forbidden" });
        }
        const q = req.query as Record<string, string | undefined>;
        const select = (q.select ?? "*").replace(/[^a-z0-9_.,():\s]/gi, "");
        const limit = Math.min(Number(q.limit ?? 100), 500);
        const pool = getPool(config);
        const filters: string[] = [];
        const params: unknown[] = [];
        let p = 1;

        if (ORG_SCOPED.has(table)) {
          filters.push(`organization_id = $${p++}`);
          params.push(user.organizationId);
        }

        for (const [key, val] of Object.entries(q)) {
          if (!val || key === "select" || key === "limit") continue;
          if (key.startsWith("eq.")) {
            const col = key.slice(3).replace(/[^a-z0-9_]/gi, "");
            if (!col) continue;
            filters.push(`${col} = $${p++}`);
            params.push(val);
          }
          if (key.startsWith("in.")) {
            const col = key.slice(3).replace(/[^a-z0-9_]/gi, "");
            const vals = val.split(",").filter(Boolean);
            if (!col || vals.length === 0) continue;
            filters.push(`${col} = ANY($${p++}::text[])`);
            params.push(vals);
          }
        }

        const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
        const sql = `SELECT ${select} FROM public.${table} ${where} LIMIT $${p}`;
        params.push(limit);
        const r = await pool.query(sql, params);
        return { items: r.rows };
      },
    );
  };
};
