import { supabase } from "@/integrations/supabase/client";

function decodeFilename(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Recover temp/{userId}/{filename} object names from receipt URLs or storage keys.
 * Needed when draft restore repopulates attachment URLs but not sessionTempFilenames.
 */
export function recoverTempFilenamesFromAttachmentUrls(
  userId: string,
  urls: string[],
  target: Set<string>,
): number {
  if (!userId) return 0;
  let recovered = 0;
  const escapedUserId = userId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`[/]temp[/]${escapedUserId}[/]([^/?#]+)`, "i"),
    new RegExp(`^temp[/]${escapedUserId}[/]([^/?#]+)`, "i"),
    new RegExp(`^receipts[/]temp[/]${escapedUserId}[/]([^/?#]+)`, "i"),
  ];

  for (const url of urls) {
    if (!url) continue;
    try {
      const candidates = new Set<string>();
      candidates.add(url);
      if (url.startsWith("http://") || url.startsWith("https://")) {
        candidates.add(new URL(url).pathname);
      }
      const receiptsIdx = url.indexOf("/receipts/");
      if (receiptsIdx !== -1) {
        candidates.add(url.slice(receiptsIdx + "/receipts/".length).split("?")[0]);
      }
      const publicIdx = url.indexOf("/object/public/receipts/");
      if (publicIdx !== -1) {
        candidates.add(url.slice(publicIdx + "/object/public/receipts/".length).split("?")[0]);
      }

      for (const candidate of candidates) {
        for (const pattern of patterns) {
          const match = candidate.match(pattern);
          if (!match?.[1]) continue;
          const fileName = decodeFilename(match[1]);
          if (!fileName) continue;
          const before = target.size;
          target.add(fileName);
          if (target.size > before) recovered += 1;
        }
      }
    } catch {
      // ignore malformed URLs
    }
  }
  return recovered;
}

/** Merge temp filenames from URLs into the session set (deduped). */
export function syncSessionTempFilenamesFromAttachments(
  userId: string,
  urls: string[],
  target: Set<string>,
): number {
  return recoverTempFilenamesFromAttachmentUrls(userId, urls, target);
}

export async function expenseHasPersistedAttachments(
  expenseId: string,
  organizationId?: string | null,
): Promise<boolean> {
  let query = supabase
    .from("attachments")
    .select("id")
    .eq("expense_id", expenseId)
    .limit(1);

  if (organizationId) {
    query = query.eq("organization_id", organizationId);
  }

  const { data, error } = await query;
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}
