/** Shared CORS helpers for browser-invoked Edge Functions (JWT verified inside the handler). */
export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-api-version, x-application-name",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function corsPreflightResponse(): Response {
  return new Response("ok", { status: 200, headers: corsHeaders });
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
