/**
 * Runtime schema for get_my_expenses_page_v1's JSONB response (§26 hardening,
 * tightened in the final pre-production correctness pass).
 *
 * The RPC is absent from the generated Supabase types, so nothing upstream
 * validates its shape. A malformed or partial payload (a bad deploy, a
 * gateway truncation, a future contract change) must produce a controlled
 * `MyExpensesPageValidationError` -- never a silently-normalized value like
 * `total_amount: 0` or `title: ""` standing in for a broken response. Every
 * field below is modeled from the ACTUAL SQL in
 * supabase/migrations/20260915120000_my_expenses_page_v1.sql's final
 * `jsonb_build_object(...)` call, not guessed:
 *
 *  - id/user_id/title/destination/trip_start/trip_end/status/total_amount/
 *    created_at/isResubmitted/wasReviewerCorrected/custom_fields are all
 *    built from NOT NULL columns (or EXISTS()/COALESCE(...,'{}') expressions
 *    that can never be null) and are ALWAYS present in the object -- these
 *    are strict and required, with no `.catch()` fallback.
 *  - transaction_number/purpose/category come from nullable `text` columns
 *    that jsonb_build_object still always includes as a key -- these are
 *    `.nullable()` (key always present, value may legitimately be null),
 *    never `.optional()`.
 *  - filtered_total/total_pages/page/page_size are all unconditionally
 *    included by the function's own `RETURN jsonb_build_object(...)` --
 *    all four are required, none optional.
 */
import { z } from "zod";

/**
 * Accepts a JS number or a numeric string ("500", "500.25") and REJECTS
 * anything that doesn't cleanly parse to a finite number -- "abc", "", " ",
 * NaN, Infinity, objects, arrays. Never silently coerces a malformed value to
 * 0; a failure here must fail the whole parse so the caller gets a controlled
 * MyExpensesPageValidationError instead of a corrupted amount/count.
 */
const numeric = z
  .union([z.number(), z.string()])
  .transform((v) => {
    if (typeof v === "number") return v;
    const trimmed = v.trim();
    return trimmed === "" ? NaN : Number(trimmed);
  })
  .pipe(z.number().finite());

const myExpensesRowSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  title: z.string(),
  destination: z.string(),
  trip_start: z.string(),
  trip_end: z.string(),
  status: z.string(),
  total_amount: numeric,
  created_at: z.string(),
  transaction_number: z.string().nullable(),
  purpose: z.string().nullable(),
  category: z.string().nullable(),
  isResubmitted: z.boolean(),
  wasReviewerCorrected: z.boolean(),
  custom_fields: z.record(z.string(), z.string()),
});

export const myExpensesPageResponseSchema = z.object({
  // No `.catch([])` here: a malformed item (missing id/trip_start, wrong
  // types) must fail validation, not silently disappear from the list.
  items: z.array(myExpensesRowSchema),
  filtered_total: numeric,
  total_pages: numeric,
  page: numeric,
  page_size: numeric,
});

export type MyExpensesPageResponse = z.infer<typeof myExpensesPageResponseSchema>;

export class MyExpensesPageValidationError extends Error {
  constructor(message = "The server returned an unexpected response shape.") {
    super(message);
    this.name = "MyExpensesPageValidationError";
  }
}

/** Throws MyExpensesPageValidationError on a malformed payload -- never returns partial/garbage data. */
export function validateMyExpensesPageResponse(data: unknown): MyExpensesPageResponse {
  const parsed = myExpensesPageResponseSchema.safeParse(data);
  if (!parsed.success) {
    throw new MyExpensesPageValidationError();
  }
  return parsed.data;
}
