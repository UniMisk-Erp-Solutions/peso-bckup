import type { FastifyReply, FastifyRequest } from "fastify";
import type { AuthUser } from "../auth/users.js";

export type SessionPayload = { userId: string; exp: number };

declare module "fastify" {
  interface FastifyRequest {
    authUser?: AuthUser;
  }
}

function readSession(req: FastifyRequest): SessionPayload | null {
  const raw = req.cookies.pesowise_session;
  if (!raw) return null;
  const unsigned = req.unsignCookie(raw);
  if (!unsigned.valid || !unsigned.value) return null;
  try {
    return JSON.parse(unsigned.value) as SessionPayload;
  } catch {
    return null;
  }
}

export async function requireAuth(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const parsed = readSession(req);
  if (!parsed?.userId || parsed.exp < Date.now()) {
    reply.code(401).send({ error: "unauthorized" });
    return;
  }
  const user = await req.server.authLoadUser?.(parsed.userId);
  if (!user) {
    reply.code(401).send({ error: "unauthorized" });
    return;
  }
  req.authUser = user;
}

export function requireRoles(roles: string[]) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await requireAuth(req, reply);
    if (reply.sent) return;
    const user = req.authUser!;
    if (!user.roles.some((r) => roles.includes(r))) {
      reply.code(403).send({ error: "forbidden" });
    }
  };
}
