const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type Body = {
  name?: string;
  email?: string;
  password?: string;
  sign_in_url?: string;
};

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEFAULT_EMAIL_FROM = "PesoWise <no-reply@unimisk.com>";
const DEFAULT_SIGNIN_URL = "https://pesowise.unimisk.com/auth";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ success: false, error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const expectedToken = Deno.env.get("EMAIL_FUNCTION_TOKEN");
    if (expectedToken) {
      const authHeader = req.headers.get("Authorization");
      const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : "";
      if (!bearerToken || bearerToken !== expectedToken) {
        return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    const resendApiKey = Deno.env.get("RESEND_API_KEY");
    const emailFrom = String(Deno.env.get("EMAIL_FROM") || DEFAULT_EMAIL_FROM).trim();
    const defaultSignInUrl = String(Deno.env.get("APP_SIGNIN_URL") || DEFAULT_SIGNIN_URL).trim();
    if (!resendApiKey) {
      throw new Error("Missing RESEND_API_KEY");
    }

    const body = (await req.json()) as Body;
    const name = String(body.name || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "").trim();
    const signInUrl = String(body.sign_in_url || defaultSignInUrl || "").trim();

    if (!name || !email || !password || !signInUrl) {
      return new Response(
        JSON.stringify({ success: false, error: "name, email, password and sign_in_url are required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    if (!EMAIL_REGEX.test(email)) {
      return new Response(JSON.stringify({ success: false, error: "Invalid recipient email" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const safeName = escapeHtml(name);
    const safeEmail = escapeHtml(email);
    const safePassword = escapeHtml(password);
    const safeSignInUrl = escapeHtml(signInUrl);

    const html = `
      <div style="font-family:Arial,sans-serif;line-height:1.5;color:#111;">
        <h2 style="margin:0 0 12px;">Welcome to PesoWise</h2>
        <p style="margin:0 0 12px;">Hi ${safeName}, your account has been created.</p>
        <p style="margin:0 0 8px;"><strong>Name:</strong> ${safeName}</p>
        <p style="margin:0 0 8px;"><strong>Email:</strong> ${safeEmail}</p>
        <p style="margin:0 0 20px;"><strong>Password:</strong> ${safePassword}</p>
        <a href="${safeSignInUrl}" style="display:inline-block;padding:10px 16px;background:#2563eb;color:#fff;text-decoration:none;border-radius:6px;">
          Sign in to your account
        </a>
        <p style="margin:16px 0 0;">If the button does not work, use this link:</p>
        <p style="margin:4px 0 0;"><a href="${safeSignInUrl}">${safeSignInUrl}</a></p>
      </div>
    `;

    const text = [
      "Welcome to PesoWise",
      `Name: ${name}`,
      `Email: ${email}`,
      `Password: ${password}`,
      `Sign in: ${signInUrl}`,
    ].join("\n");

    const resendResponse = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: emailFrom,
        to: [email],
        subject: "Your PesoWise account is ready",
        html,
        text,
      }),
    });

    const resendJson = await resendResponse.json();
    if (!resendResponse.ok) {
      console.error("send-account-created-email: resend failed", {
        status: resendResponse.status,
        email,
        password: "***masked***",
        resend: resendJson,
      });
      return new Response(JSON.stringify({ success: false, error: "Failed to send account email", resend: resendJson }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ success: true, id: resendJson?.id || null }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    return new Response(JSON.stringify({ success: false, error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
