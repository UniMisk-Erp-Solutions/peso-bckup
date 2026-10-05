import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const VERSION = "receipt-finalizer-v4";

// Exact origins permitted (no subdomain).
const ALLOWED_EXACT_ORIGINS = [
  "https://pesowise.unimisk.com",
  "http://localhost:5173",
  "http://localhost:3000",
  "http://localhost:8080",
];

// Tenant subdomains: any https://<slug>.pesowise.unimisk.com.
// The regex anchors both ends and enforces https-only to prevent subdomain
// spoofing over plain HTTP.
const TENANT_SUBDOMAIN_RE = /^https:\/\/[a-z0-9-]+\.pesowise\.unimisk\.com$/;

function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return false;
  return (
    ALLOWED_EXACT_ORIGINS.includes(origin) || TENANT_SUBDOMAIN_RE.test(origin)
  );
}

// Stage identifiers used in structured error responses.
type ReceiptFinalizationStage =
  | "environment"
  | "method"
  | "auth"
  | "input"
  | "ownership"
  | "finalization";

function corsHeaders(origin: string | null): Record<string, string> {
  const allowed = isAllowedOrigin(origin) ? origin! : ALLOWED_EXACT_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}

function jsonResponse(
  body: unknown,
  status: number,
  origin: string | null,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(origin),
      "Content-Type": "application/json",
    },
  });
}

function okResponse(
  requestId: string,
  origin: string | null,
  results: unknown[],
): Response {
  return jsonResponse(
    { ok: true, requestId, version: VERSION, results },
    200,
    origin,
  );
}

function errResponse(
  requestId: string,
  origin: string | null,
  status: number,
  stage: ReceiptFinalizationStage,
  code: string,
  message: string,
): Response {
  return jsonResponse(
    { ok: false, requestId, version: VERSION, stage, code, message },
    status,
    origin,
  );
}

type ReceiptInput = {
  filename: string;
  contentType?: string;
  fileSize?: number;
};

type ReceiptResult = {
  filename: string;
  sourcePath: string;
  desiredFinalPath: string;
  resolvedPath: string | null;
  status: "finalized" | "temporary_fallback" | "failed";
  fileUrl?: string;
  errorMessage?: string;
};

async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  }
  const count = Math.min(limit, tasks.length);
  if (count === 0) return results;
  await Promise.all(Array.from({ length: count }, worker));
  return results;
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  const requestId = crypto.randomUUID();

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }

  if (req.method !== "POST") {
    return errResponse(
      requestId,
      origin,
      405,
      "method",
      "METHOD_NOT_ALLOWED",
      "Only POST is accepted",
    );
  }

  // Validate required environment variables before any client construction.
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    console.error("[finalize-receipts] missing environment variables", {
      requestId,
      hasUrl: Boolean(supabaseUrl),
      hasKey: Boolean(serviceRoleKey),
    });
    return errResponse(
      requestId,
      origin,
      503,
      "environment",
      "SERVER_MISCONFIGURATION",
      "Server misconfiguration — missing required environment variables",
    );
  }

  try {
    const serviceClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false },
    });

    // Authenticate the calling user via their JWT.
    const authHeader = req.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return errResponse(
        requestId,
        origin,
        401,
        "auth",
        "MISSING_AUTH_HEADER",
        "Missing or malformed Authorization header",
      );
    }
    const jwt = authHeader.slice("Bearer ".length);

    const {
      data: { user },
      error: userError,
    } = await serviceClient.auth.getUser(jwt);
    if (userError || !user) {
      return errResponse(
        requestId,
        origin,
        401,
        "auth",
        "INVALID_JWT",
        "Token validation failed or user not found",
      );
    }

    // Parse and validate the request body.
    let body: { expenseId: string; receipts: ReceiptInput[] };
    try {
      body = await req.json();
    } catch {
      return errResponse(
        requestId,
        origin,
        400,
        "input",
        "INVALID_JSON",
        "Request body is not valid JSON",
      );
    }

    const { expenseId, receipts } = body;

    if (!expenseId || typeof expenseId !== "string") {
      return errResponse(
        requestId,
        origin,
        422,
        "input",
        "MISSING_EXPENSE_ID",
        "expenseId is required and must be a string",
      );
    }
    if (!Array.isArray(receipts) || receipts.length === 0) {
      return errResponse(
        requestId,
        origin,
        422,
        "input",
        "INVALID_RECEIPTS",
        "receipts must be a non-empty array",
      );
    }

    // Validate expense ownership — prevents users from finalizing receipts into
    // someone else's expense folder. An org admin may also finalize receipts
    // for an expense they didn't submit themselves, mirroring the same
    // admin-bypass pattern already used for the attachments table INSERT
    // policy: the admin-submit-for-employee feature's optional receipt
    // upload needs this, since the caller there is never expense.user_id.
    // Ported from Preet-Patel/feature/admin-submit-expense-for-employee
    // commit 225a3142, the exact same defect class (a strict owner-only
    // check silently swallowed by invokeFinalizeExpenseReceipts's designed-in
    // fallback into a per-file "failed" result with no visible error).
    const { data: expense, error: expenseError } = await serviceClient
      .from("expenses")
      .select("id, user_id, organization_id")
      .eq("id", expenseId)
      .single();

    let authorized = !expenseError && !!expense && expense.user_id === user.id;
    if (!authorized && expense?.organization_id) {
      const { data: adminMembership } = await serviceClient
        .from("organization_memberships")
        .select("id")
        .eq("user_id", user.id)
        .eq("organization_id", expense.organization_id)
        .eq("role", "admin")
        .eq("is_active", true)
        .maybeSingle();
      authorized = !!adminMembership;
    }

    if (!authorized) {
      return errResponse(
        requestId,
        origin,
        403,
        "ownership",
        "EXPENSE_ACCESS_DENIED",
        "Expense not found or access denied",
      );
    }

    const tasks = receipts.map(
      (receipt) => async (): Promise<ReceiptResult> => {
        const { filename } = receipt;

        if (
          !filename ||
          typeof filename !== "string" ||
          filename.includes("/") ||
          /^https?:\/\//.test(filename)
        ) {
          return {
            filename: filename ?? "",
            sourcePath: "",
            desiredFinalPath: "",
            resolvedPath: null,
            status: "failed",
            errorMessage:
              "filename must be a bare filename without path separators or URL scheme",
          };
        }

        const sourcePath = `temp/${user.id}/${filename}`;
        const destPath = `${expenseId}/${filename}`;

        // A. Idempotent probe — if destination already exists, skip the write.
        const { data: existingFiles } = await serviceClient.storage
          .from("receipts")
          .list(expenseId, { search: filename, limit: 1 });

        if (existingFiles?.some((f) => f.name === filename)) {
          const { data: urlData } = serviceClient.storage
            .from("receipts")
            .getPublicUrl(destPath);
          return {
            filename,
            sourcePath,
            desiredFinalPath: destPath,
            resolvedPath: destPath,
            status: "finalized",
            fileUrl: urlData.publicUrl,
          };
        }

        // B. Download source.
        const { data: sourceBlob, error: downloadError } =
          await serviceClient.storage.from("receipts").download(sourcePath);

        if (downloadError || !sourceBlob) {
          console.error("[finalize-receipts] source download failed", {
            requestId,
            expenseId,
            sourcePath,
            error: downloadError?.message,
          });
          return {
            filename,
            sourcePath,
            desiredFinalPath: destPath,
            resolvedPath: null,
            status: "failed",
            errorMessage:
              downloadError?.message ?? "Source file not found or inaccessible",
          };
        }

        // C. Upload to destination.
        const { error: uploadError } = await serviceClient.storage
          .from("receipts")
          .upload(destPath, sourceBlob, {
            upsert: true,
            contentType: receipt.contentType || "image/jpeg",
          });

        if (uploadError) {
          console.warn("[finalize-receipts] upload error (verifying anyway)", {
            requestId,
            expenseId,
            destPath,
            error: uploadError.message,
          });
        }

        // D. Download-verify — the only authoritative proof the write succeeded.
        const { data: verifyBlob, error: verifyError } =
          await serviceClient.storage.from("receipts").download(destPath);

        if (!verifyError && verifyBlob) {
          const { data: urlData } = serviceClient.storage
            .from("receipts")
            .getPublicUrl(destPath);
          return {
            filename,
            sourcePath,
            desiredFinalPath: destPath,
            resolvedPath: destPath,
            status: "finalized",
            fileUrl: urlData.publicUrl,
          };
        }

        // E. Temp-path fallback — file is accessible at source but could not be
        //    written to the destination. Return temp URL so expense can still submit.
        console.error(
          "[finalize-receipts] upload verify failed — temp-path fallback",
          {
            requestId,
            expenseId,
            sourcePath,
            destPath,
            uploadError: uploadError?.message,
            verifyError: verifyError?.message,
          },
        );
        const { data: tempUrlData } = serviceClient.storage
          .from("receipts")
          .getPublicUrl(sourcePath);
        return {
          filename,
          sourcePath,
          desiredFinalPath: destPath,
          resolvedPath: sourcePath,
          status: "temporary_fallback",
          fileUrl: tempUrlData.publicUrl,
        };
      },
    );

    const results = await runWithConcurrency(tasks, 2);
    return okResponse(requestId, origin, results);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unexpected server error";
    console.error("[finalize-receipts] unhandled exception", {
      requestId,
      message,
    });
    return errResponse(
      requestId,
      origin,
      500,
      "finalization",
      "INTERNAL_ERROR",
      "An unexpected error occurred",
    );
  }
});
