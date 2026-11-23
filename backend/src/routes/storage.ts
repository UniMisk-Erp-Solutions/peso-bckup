import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { requireAuth } from "../middleware/auth.js";
import { getPool } from "../db/pool.js";
import { canAccessAttachmentKey } from "../services/access.js";
import type { AppConfig } from "../config.js";

function s3Client(config: AppConfig): S3Client {
  if (!config.minioEndpoint || !config.minioAccessKey || !config.minioSecretKey) {
    throw new Error("MinIO is not configured");
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

const ALLOWED_BUCKETS = new Set([
  "receipts",
  "expense-attachments",
  "organization-logos",
  "generated-reports",
  "balance-import-archive",
  "bills",
]);

export const storageRoutes = (config: AppConfig): FastifyPluginAsync => {
  return async (app) => {
    app.get(
      "/api/storage/sign-download",
      { preHandler: requireAuth },
      async (req, reply) => {
        const q = z
          .object({
            bucket: z.string(),
            key: z.string().min(1),
          })
          .parse(req.query);
        if (!ALLOWED_BUCKETS.has(q.bucket)) {
          return reply.code(400).send({ error: "invalid_bucket" });
        }
        if (q.key.includes("..") || q.key.startsWith("/")) {
          return reply.code(400).send({ error: "invalid_key" });
        }
        const user = req.authUser!;
        if (!user.organizationId) {
          return reply.code(403).send({ error: "forbidden" });
        }
        const pool = getPool(config);
        const pgClient = await pool.connect();
        try {
          if (!(await canAccessAttachmentKey(pgClient, user, q.bucket, q.key))) {
            return reply.code(403).send({ error: "forbidden" });
          }
        } finally {
          pgClient.release();
        }
        const pool2 = getPool(config);
        const verR = await pool2.query<{ version: string | null }>(
          `SELECT version FROM storage.objects WHERE bucket_id = $1 AND name = $2 LIMIT 1`,
          [q.bucket, q.key],
        );
        const version = verR.rows[0]?.version;
        const client = s3Client(config);
        const objectKey = version
          ? `${config.minioObjectPrefix}/${q.bucket}/${q.key}/${version}`
          : `${config.minioObjectPrefix}/${q.bucket}/${q.key}`;
        const url = await getSignedUrl(
          client,
          new GetObjectCommand({ Bucket: config.minioBucket, Key: objectKey }),
          { expiresIn: 300 },
        );
        return { url, expiresIn: 300 };
      },
    );

    app.post(
      "/api/storage/sign-upload",
      { preHandler: requireAuth },
      async (req, reply) => {
        const body = z
          .object({
            bucket: z.string(),
            key: z.string().min(1),
            contentType: z.string().optional(),
          })
          .parse(req.body);
        if (!ALLOWED_BUCKETS.has(body.bucket)) {
          return reply.code(400).send({ error: "invalid_bucket" });
        }
        const client = s3Client(config);
        const objectKey = `${config.minioObjectPrefix}/${body.bucket}/${body.key}`;
        const url = await getSignedUrl(
          client,
          new PutObjectCommand({
            Bucket: config.minioBucket,
            Key: objectKey,
            ContentType: body.contentType,
          }),
          { expiresIn: 300 },
        );
        return { url, expiresIn: 300 };
      },
    );
  };
};
