/** Environment keys for cold tier (never commit secrets). */
export const ARCHIVE_ENV_KEYS = {
  provider: "ARCHIVE_STORAGE_PROVIDER",
  path: "ARCHIVE_STORAGE_PATH",
  bucket: "ARCHIVE_BUCKET",
  retentionDays: "ARCHIVE_RETENTION_DAYS",
} as const;

export type ArchiveStorageProvider =
  | "postgres_archive_schema"
  | "minio"
  | "nas"
  | "s3_compatible"
  | "local_sas";
