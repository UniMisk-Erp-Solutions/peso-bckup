import { supabase } from "@/integrations/supabase/client";

const COMMON_CATEGORY_HINTS = [
  "Travel",
  "Food",
  "Office Supplies",
  "Transport",
  "Meals",
  "Fuel",
  "Accommodation",
];

/** Top 3 category names for the current user (usage history, then fallbacks). */
export async function fetchRecommendedCategories(
  organizationId: string,
  userId: string,
  categories: string[],
): Promise<string[]> {
  if (categories.length === 0) return [];

  try {
    const { data, error } = await supabase
      .from("category_usage_tracking")
      .select("category_name, usage_count")
      .eq("organization_id", organizationId)
      .eq("user_id", userId)
      .order("usage_count", { ascending: false })
      .order("last_used_at", { ascending: false })
      .limit(4);

    if (error) {
      console.error("Failed to fetch recommended categories:", error);
    }

    let recommended: string[] = [];
    if (data && data.length > 0) {
      recommended = data
        .map((item) => item.category_name)
        .filter((name): name is string => Boolean(name && categories.includes(name)));
    }

    if (recommended.length < 3) {
      const availableCommon = categories.filter(
        (cat) =>
          !recommended.includes(cat) &&
          COMMON_CATEGORY_HINTS.some((hint) => cat.toLowerCase().includes(hint.toLowerCase())),
      );
      const needed = 3 - recommended.length;
      recommended = [...recommended, ...availableCommon.slice(0, needed)];
      if (recommended.length < 3) {
        const remaining = categories.filter((cat) => !recommended.includes(cat));
        recommended = [...recommended, ...remaining.slice(0, 3 - recommended.length)];
      }
    }

    return recommended.slice(0, 3);
  } catch (e) {
    console.error("Error fetching recommended categories:", e);
    return categories.slice(0, 3);
  }
}
