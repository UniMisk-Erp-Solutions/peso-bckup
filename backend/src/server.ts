import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import { loadConfig } from "./config.js";
import { healthRoutes } from "./routes/health.js";
import { authRoutes } from "./routes/auth.js";
import { expenseRoutes } from "./routes/expenses.js";
import { storageRoutes } from "./routes/storage.js";
import { dataRoutes } from "./routes/data.js";
import { rpcRoutes } from "./routes/rpc.js";
import { getPool } from "./db/pool.js";
import { loadAuthUser } from "./auth/users.js";
import { notificationRoutes } from "./routes/notifications.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { eventsRoutes } from "./routes/events.js";

async function main() {
  const config = loadConfig();
  const app = Fastify({ logger: true });

  await app.register(cors, {
    origin: config.frontendOrigin.includes(",")
      ? config.frontendOrigin.split(",").map((s) => s.trim())
      : config.frontendOrigin,
    credentials: true,
  });
  await app.register(cookie, { secret: config.sessionSecret });
  await app.register(healthRoutes(config));

  if (config.databaseUrl) {
    const pool = getPool(config);
    app.log.info(
      {
        environment: config.appEnv,
        migrationStage: config.migrationStage,
        database_target: config.expectedDbContainer ?? "pesowise-postgres-migration-v2",
        storage_target: config.expectedMinioContainer ?? "pesowise-minio-migration-v2",
      },
      "PesoWise API startup",
    );
    app.decorate("authLoadUser", async (userId: string) => {
      const client = await pool.connect();
      try {
        return await loadAuthUser(client, userId);
      } finally {
        client.release();
      }
    });
    await app.register(authRoutes(config));
    await app.register(expenseRoutes(config));
    await app.register(storageRoutes(config));
    await app.register(dataRoutes(config));
    await app.register(rpcRoutes(config));
    await app.register(dashboardRoutes(config));
    await app.register(notificationRoutes(config));
    await app.register(eventsRoutes);
  }

  await app.listen({ host: config.host, port: config.port });
}

declare module "fastify" {
  interface FastifyInstance {
    authLoadUser?: (userId: string) => Promise<import("./auth/users.js").AuthUser | null>;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
