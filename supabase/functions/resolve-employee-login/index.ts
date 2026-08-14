/**
 * @deprecated Employee ID login uses public.get_employee_auth_email RPC from the Auth page.
 * This function is disabled to avoid an unauthenticated email lookup surface.
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: Record<string, unknown>, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  return jsonResponse(
    {
      success: false,
      error: "This login endpoint is disabled. Sign in through your organization subdomain.",
      code: "DEPRECATED",
    },
    410,
  );
});
