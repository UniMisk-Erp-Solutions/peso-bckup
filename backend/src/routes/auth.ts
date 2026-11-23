import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { getPool } from "../db/pool.js";
import { findUserByEmail, loadAuthUser, verifyPassword } from "../auth/users.js";
import type { AppConfig } from "../config.js";

const loginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const authRoutes = (config: AppConfig): FastifyPluginAsync => {
  return async (app) => {
    app.post("/api/auth/login", async (req, reply) => {
      const body = loginBody.parse(req.body);
      const pool = getPool(config);
      const client = await pool.connect();
      try {
        const found = await findUserByEmail(client, body.email);
        if (!found || !(await verifyPassword(body.password, found.encryptedPassword))) {
          return reply.code(401).send({ error: "invalid_credentials" });
        }
        const user = await loadAuthUser(client, found.id);
        if (!user) return reply.code(401).send({ error: "invalid_credentials" });
        const activeR = await client.query<{ ok: boolean }>(
          `SELECT coalesce(
             (SELECT is_active FROM public.profiles WHERE id = $1),
             (SELECT is_active FROM public.profiles WHERE user_id = $1),
             true
           ) AS ok`,
          [found.id],
        );
        if (activeR.rows[0]?.ok === false) {
          return reply.code(403).send({ error: "account_inactive" });
        }
        const exp = Date.now() + 1000 * 60 * 60 * 12;
        const payload = JSON.stringify({ userId: user.id, exp });
        reply.setCookie("pesowise_session", payload, {
          path: "/",
          httpOnly: true,
          secure: config.frontendOrigin.startsWith("https"),
          sameSite: "lax",
          signed: true,
        });
        return {
          user: {
            id: user.id,
            email: user.email,
            roles: user.roles,
            organizationId: user.organizationId,
          },
        };
      } finally {
        client.release();
      }
    });

    app.post("/api/auth/logout", async (_req, reply) => {
      reply.clearCookie("pesowise_session", { path: "/", signed: true });
      return { ok: true };
    });

    app.get("/api/auth/me", async (req, reply) => {
      const raw = req.cookies.pesowise_session;
      if (!raw) return reply.code(401).send({ error: "unauthorized" });
      const unsigned = req.unsignCookie(raw);
      if (!unsigned.valid || !unsigned.value) {
        return reply.code(401).send({ error: "invalid_session" });
      }
      const parsed = JSON.parse(unsigned.value) as { userId: string; exp: number };
      if (parsed.exp < Date.now()) return reply.code(401).send({ error: "session_expired" });
      const pool = getPool(config);
      const client = await pool.connect();
      try {
        const user = await loadAuthUser(client, parsed.userId);
        if (!user) return reply.code(401).send({ error: "unauthorized" });
        return { user: { id: user.id, email: user.email, roles: user.roles, organizationId: user.organizationId } };
      } finally {
        client.release();
      }
    });
  };
};
