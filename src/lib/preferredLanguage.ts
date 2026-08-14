import { supabase } from "@/integrations/supabase/client";
import type { AppLanguage } from "@/i18n/config";
import { normalizeAppLanguage } from "@/i18n/config";

export async function updateUserPreferredLanguage(
  userId: string,
  language: AppLanguage,
): Promise<{ error: Error | null }> {
  const { error } = await (supabase as any)
    .from("profiles")
    .update({ preferred_language: language })
    .eq("user_id", userId);

  return { error: error as Error | null };
}

export async function fetchUserPreferredLanguage(userId: string): Promise<AppLanguage> {
  const { data, error } = await (supabase as any)
    .from("profiles")
    .select("preferred_language")
    .eq("user_id", userId)
    .maybeSingle() as { data: { preferred_language?: string } | null; error: Error | null };

  if (error || !data) return "en";
  return normalizeAppLanguage(data.preferred_language);
}
