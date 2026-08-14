const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type ContactPayload = {
  full_name?: string;
  work_email?: string;
  company?: string;
  phone?: string | null;
  role?: string | null;
  team_size?: string | null;
  multi_level?: boolean;
  balance?: boolean;
  multi_location?: boolean;
  receipts?: boolean;
  message?: string | null;
  consent_privacy?: boolean;
  consent_marketing?: boolean;
  consent_timestamp?: string | null;
  consent_version?: number | null;
};

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEFAULT_EMAIL_FROM = "PesoWise <no-reply@unimisk.com>";
const DEFAULT_CONTACT_NOTIFY_TO = [
  "mithil20056mistry@gmail.com",
  "ranaharmin@gmail.com",
];

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function boolLabel(value: boolean | undefined): string {
  return value ? "Yes" : "No";
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
    const notifyTo = String(Deno.env.get("CONTACT_NOTIFY_TO") || DEFAULT_CONTACT_NOTIFY_TO.join(",")).trim();
    if (!resendApiKey) {
      throw new Error("Missing RESEND_API_KEY");
    }

    const recipients = notifyTo
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    if (!recipients.length || recipients.some((email) => !EMAIL_REGEX.test(email))) {
      throw new Error("CONTACT_NOTIFY_TO must contain valid comma-separated emails");
    }

    const body = (await req.json()) as ContactPayload;
    const fullName = String(body.full_name || "").trim();
    const workEmail = String(body.work_email || "").trim().toLowerCase();
    const company = String(body.company || "").trim();
    if (!fullName || !workEmail || !company || !EMAIL_REGEX.test(workEmail)) {
      return new Response(JSON.stringify({ success: false, error: "full_name, work_email and company are required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const safeFullName = escapeHtml(fullName);
    const safeWorkEmail = escapeHtml(workEmail);
    const safeCompany = escapeHtml(company);
    const safePhone = escapeHtml(String(body.phone || "-"));
    const safeRole = escapeHtml(String(body.role || "-"));
    const safeTeamSize = escapeHtml(String(body.team_size || "-"));
    const safeMessage = escapeHtml(String(body.message || "-"));
    const safeConsentTs = escapeHtml(String(body.consent_timestamp || "-"));
    const consentVersion = Number(body.consent_version || 1);

    const html = `
      <div style="font-family:Arial,sans-serif;line-height:1.5;color:#111;">
        <h2 style="margin:0 0 12px;">New Contact Us inquiry</h2>
        <p style="margin:0 0 8px;"><strong>Full Name:</strong> ${safeFullName}</p>
        <p style="margin:0 0 8px;"><strong>Work Email:</strong> ${safeWorkEmail}</p>
        <p style="margin:0 0 8px;"><strong>Company:</strong> ${safeCompany}</p>
        <p style="margin:0 0 8px;"><strong>Phone:</strong> ${safePhone}</p>
        <p style="margin:0 0 8px;"><strong>Role:</strong> ${safeRole}</p>
        <p style="margin:0 0 8px;"><strong>Team Size:</strong> ${safeTeamSize}</p>
        <p style="margin:0 0 8px;"><strong>Workflow: Multi-level approvals:</strong> ${boolLabel(body.multi_level)}</p>
        <p style="margin:0 0 8px;"><strong>Workflow: Balance management:</strong> ${boolLabel(body.balance)}</p>
        <p style="margin:0 0 8px;"><strong>Workflow: Multi-location:</strong> ${boolLabel(body.multi_location)}</p>
        <p style="margin:0 0 8px;"><strong>Workflow: Receipts:</strong> ${boolLabel(body.receipts)}</p>
        <p style="margin:0 0 8px;"><strong>Message:</strong><br/>${safeMessage}</p>
        <hr style="margin:16px 0;border:none;border-top:1px solid #ddd;" />
        <p style="margin:0 0 8px;"><strong>Consent privacy:</strong> ${boolLabel(body.consent_privacy)}</p>
        <p style="margin:0 0 8px;"><strong>Consent marketing:</strong> ${boolLabel(body.consent_marketing)}</p>
        <p style="margin:0 0 8px;"><strong>Consent timestamp:</strong> ${safeConsentTs}</p>
        <p style="margin:0;"><strong>Consent version:</strong> ${consentVersion}</p>
      </div>
    `;

    const text = [
      "New Contact Us inquiry",
      `Full Name: ${fullName}`,
      `Work Email: ${workEmail}`,
      `Company: ${company}`,
      `Phone: ${String(body.phone || "-")}`,
      `Role: ${String(body.role || "-")}`,
      `Team Size: ${String(body.team_size || "-")}`,
      `Multi-level approvals: ${boolLabel(body.multi_level)}`,
      `Balance management: ${boolLabel(body.balance)}`,
      `Multi-location: ${boolLabel(body.multi_location)}`,
      `Receipts: ${boolLabel(body.receipts)}`,
      `Message: ${String(body.message || "-")}`,
      `Consent privacy: ${boolLabel(body.consent_privacy)}`,
      `Consent marketing: ${boolLabel(body.consent_marketing)}`,
      `Consent timestamp: ${String(body.consent_timestamp || "-")}`,
      `Consent version: ${consentVersion}`,
    ].join("\n");

    const resendBody: Record<string, unknown> = {
      from: emailFrom,
      to: recipients,
      subject: "New Contact Us inquiry from website",
      html,
      text,
    };
    if (EMAIL_REGEX.test(workEmail)) {
      resendBody.reply_to = workEmail;
    }

    const resendResponse = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(resendBody),
    });

    const resendJson = await resendResponse.json();
    if (!resendResponse.ok) {
      console.error("send-contact-lead-email: resend failed", {
        status: resendResponse.status,
        recipients,
        resend: resendJson,
      });
      return new Response(JSON.stringify({ success: false, error: "Failed to send contact notification", resend: resendJson }), {
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
