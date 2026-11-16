import type { FastifyPluginAsync } from "fastify";
import pg from "pg";
import { S3Client, ListBucketsCommand } from "@aws-sdk/client-s3";
import type { AppConfig } from "../config.js";

function minioClient(config: AppConfig): S3Client | null {
  if (!config.minioEndpoint || !config.minioAccessKey || !config.minioSecretKey) {
    return null;
  }
  return new S3Client({
    endpoint: config.minioEndpoint,
    region: "us-east-1",
    credentials: {
      accessKeyId: config.minioAccessKey,
      secretAccessKey: config.minioSecretKey,
    },
    forcePathStyle: true,
  });
}

export const healthRoutes = (config: AppConfig): FastifyPluginAsync => {
  return async (app) => {
    app.get("/health", async () => ({
      ok: true,
      environment: config.appEnv,
      migrationStage: config.migrationStage,
      service: "pesowise-api",
    }));

    app.get("/ready", async () => {
      const out: Record<string, unknown> = {
        ok: true,
        environment: config.appEnv,
        migrationStage: config.migrationStage,
        database_target: config.expectedDbContainer ?? "pesowise-postgres-migration-v2",
        storage_target: config.expectedMinioContainer ?? "pesowise-minio-migration-v2",
      };

      if (!config.databaseUrl) {
        out.ok = false;
        out.database = "not_configured";
        return out;
      }
      const client = new pg.Client({ connectionString: config.databaseUrl });
      try {
        await client.connect();
        const r = await client.query("SELECT 1 AS n");
        out.database = r.rows[0]?.n === 1 ? "connected" : "error";
      } catch {
        out.ok = false;
        out.database = "error";
      } finally {
        await client.end().catch(() => {});
      }

      const s3 = minioClient(config);
      if (!s3) {
        out.storage = "not_configured";
      } else {
        try {
          await s3.send(new ListBucketsCommand({}));
          out.storage = "connected";
        } catch {
          out.ok = false;
          out.storage = "error";
        }
      }
      return out;
    });
  };
};
