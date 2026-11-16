import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.string().optional(),
  APP_ENV: z.enum(["staging", "production", "development"]).optional(),
  MIGRATION_STAGE: z.string().optional(),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().default(8787),
  DATABASE_URL: z.string().optional(),
  SESSION_SECRET: z.string().min(16).optional(),
  FRONTEND_ORIGIN: z.string().optional(),
  FORBIDDEN_SUPABASE_HOST: z.string().optional(),
  FORBIDDEN_SUPABASE_DB_CONTAINER: z.string().optional(),
  FORBIDDEN_PRODUCTION_MINIO_CONTAINER: z.string().optional(),
  MINIO_ENDPOINT: z.string().url().optional(),
  MINIO_ACCESS_KEY: z.string().optional(),
  MINIO_SECRET_KEY: z.string().optional(),
  MINIO_BUCKET: z.string().default("stub"),
  MINIO_OBJECT_PREFIX: z.string().default("storage-single-tenant"),
  EXPECTED_DB_CONTAINER: z.string().optional(),
  EXPECTED_MINIO_CONTAINER: z.string().optional(),
});

export type AppConfig = {
  host: string;
  port: number;
  appEnv: string;
  migrationStage: boolean;
  databaseUrl?: string;
  sessionSecret: string;
  frontendOrigin: string;
  minioEndpoint?: string;
  minioAccessKey?: string;
  minioSecretKey?: string;
  minioBucket: string;
  minioObjectPrefix: string;
  expectedDbContainer?: string;
  expectedMinioContainer?: string;
};

function assertNotContains(haystack: string, needle: string, message: string): void {
  if (needle && haystack.toLowerCase().includes(needle.toLowerCase())) {
    throw new Error(message);
  }
}

export function loadConfig(): AppConfig {
  const parsed = envSchema.parse(process.env);
  const appEnv = parsed.APP_ENV ?? (parsed.NODE_ENV === "production" ? "production" : "development");
  const migrationStage = parsed.MIGRATION_STAGE === "true";

  if (migrationStage && appEnv !== "staging") {
    throw new Error("Refusing to start: MIGRATION_STAGE=true requires APP_ENV=staging");
  }
  if (appEnv === "staging" && parsed.NODE_ENV === "production") {
    throw new Error("Refusing to start: APP_ENV=staging cannot run with NODE_ENV=production");
  }

  const databaseUrl = parsed.DATABASE_URL;
  if (databaseUrl) {
    if (parsed.FORBIDDEN_SUPABASE_HOST) {
      assertNotContains(
        databaseUrl,
        parsed.FORBIDDEN_SUPABASE_HOST,
        "Refusing to start: DATABASE_URL points at forbidden Supabase host",
      );
    }
    if (parsed.FORBIDDEN_SUPABASE_DB_CONTAINER) {
      assertNotContains(
        databaseUrl,
        parsed.FORBIDDEN_SUPABASE_DB_CONTAINER,
        "Refusing to start: DATABASE_URL references production Supabase DB container",
      );
    }
    if (databaseUrl.includes("supabase-db-kar0ro1k6jiyfxzzw7acnsza")) {
      throw new Error("Refusing to start: DATABASE_URL must not target production Supabase DB");
    }
    if (!databaseUrl.includes("15432") && appEnv === "staging") {
      throw new Error("Refusing to start: staging DATABASE_URL must use migration v2 port 15432");
    }
  }

  if (parsed.MINIO_ENDPOINT) {
    if (parsed.FORBIDDEN_PRODUCTION_MINIO_CONTAINER) {
      assertNotContains(
        parsed.MINIO_ENDPOINT,
        parsed.FORBIDDEN_PRODUCTION_MINIO_CONTAINER,
        "Refusing to start: MINIO_ENDPOINT references production MinIO",
      );
    }
    if (parsed.MINIO_ENDPOINT.includes("supabase-minio-kar0ro1k6jiyfxzzw7acnsza")) {
      throw new Error("Refusing to start: MINIO_ENDPOINT must not target production Supabase MinIO");
    }
    if (appEnv === "staging" && !parsed.MINIO_ENDPOINT.includes("19000")) {
      throw new Error("Refusing to start: staging MINIO_ENDPOINT must use migration port 19000");
    }
  }

  const sessionSecret =
    parsed.SESSION_SECRET ??
    (appEnv === "production"
      ? (() => {
          throw new Error("SESSION_SECRET is required in production");
        })()
      : "dev-only-session-secret-change-me");

  return {
    host: parsed.HOST,
    port: parsed.PORT,
    appEnv,
    migrationStage,
    databaseUrl,
    sessionSecret,
    frontendOrigin: parsed.FRONTEND_ORIGIN ?? "http://127.0.0.1:5174",
    minioEndpoint: parsed.MINIO_ENDPOINT,
    minioAccessKey: parsed.MINIO_ACCESS_KEY,
    minioSecretKey: parsed.MINIO_SECRET_KEY,
    minioBucket: parsed.MINIO_BUCKET,
    minioObjectPrefix: parsed.MINIO_OBJECT_PREFIX,
    expectedDbContainer: parsed.EXPECTED_DB_CONTAINER,
    expectedMinioContainer: parsed.EXPECTED_MINIO_CONTAINER,
  };
}
