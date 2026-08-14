/**
 * Review Queue V2 rollout flag (DOC-079).
 *
 * Default OFF. While disabled the V1 EngineerReview pipeline is used unchanged and
 * no V2 RPC is ever called. When enabled the client uses the V2 contracts only —
 * there is deliberately NO silent fallback to V1, because silent fallbacks are what
 * masked the missing-RPC failures in V1.
 */
export const REVIEW_QUEUE_V2_ENABLED =
  (import.meta.env.VITE_REVIEW_QUEUE_V2_ENABLED as string | undefined)?.trim() === "true";

/** Contract version the client requires from review_queue_api_version(). */
export const REVIEW_QUEUE_REQUIRED_API_VERSION = 2;
