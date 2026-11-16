/**
 * Attachment URL resolution (Phase 12 abstraction).
 * Hot-only until cold catalog + provider are configured. Does not change Storage paths.
 */

export type AttachmentUrlResult =
  | { tier: "hot"; url: string }
  | { tier: "archive"; url: string }
  | { tier: "unavailable"; reason: string };

export async function getAttachmentUrl(params: {
  hotSignedUrl: string | null;
  archiveSignedUrl?: string | null;
}): Promise<AttachmentUrlResult> {
  if (params.hotSignedUrl) {
    return { tier: "hot", url: params.hotSignedUrl };
  }
  if (params.archiveSignedUrl) {
    return { tier: "archive", url: params.archiveSignedUrl };
  }
  return { tier: "unavailable", reason: "No hot or archived object" };
}
