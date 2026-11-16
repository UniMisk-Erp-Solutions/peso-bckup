import { EventEmitter } from "node:events";
import type { FastifyPluginAsync } from "fastify";
import { requireAuth } from "../middleware/auth.js";

export const migrationEvents = new EventEmitter();
migrationEvents.setMaxListeners(200);

export const eventsRoutes: FastifyPluginAsync = async (app) => {
  app.get("/api/events", { preHandler: requireAuth }, async (req, reply) => {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const userId = req.authUser!.id;
    const onNotify = (payload: { userId: string; type: string; data: unknown }) => {
      if (payload.userId !== userId) return;
      reply.raw.write(`event: ${payload.type}\ndata: ${JSON.stringify(payload.data)}\n\n`);
    };
    migrationEvents.on("notify", onNotify);
    req.raw.on("close", () => {
      migrationEvents.off("notify", onNotify);
    });
    reply.raw.write(`event: connected\ndata: {}\n\n`);
    return reply;
  });
};

export function emitUserEvent(userId: string, type: string, data: unknown): void {
  migrationEvents.emit("notify", { userId, type, data });
}
