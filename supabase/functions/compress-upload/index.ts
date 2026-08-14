import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { PDFDocument } from "https://esm.sh/pdf-lib@1.17.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type CompressUploadRequest = {
  file_name?: string;
  mime_type?: string;
  file_base64?: string;
  target_bytes?: number;
  absolute_cap_bytes?: number;
  /** When true: upload to temp/{userId}/{file_name} server-side and return storage_path/public_url.
   *  Used for images to bypass browser→storage CORS/timeout issues. */
  upload_to_temp?: boolean;
};

type CompressUploadResponse = {
  ok: boolean;
  file_name?: string;
  mime_type?: string;
  compressed_base64?: string;
  /** Set when upload_to_temp was true and the server-side upload succeeded. */
  storage_path?: string;
  public_url?: string;
  originalSize?: number;
  compressedSize?: number;
  ratio?: number;
  strategy?: string;
  warnings?: string[];
  errorCode?: "UNAUTHORIZED" | "UNSUPPORTED_TYPE" | "INPUT_TOO_LARGE" | "TIMEOUT" | "COMPRESSION_FAILED";
  message?: string;
};

const ALLOWED_MIME = new Set(["image/jpeg", "image/jpg", "image/png", "image/heic", "image/heif", "application/pdf"]);
const MAX_INPUT_BYTES = 50 * 1024 * 1024;
const BASE64_REGEX = /^[A-Za-z0-9+/=]+$/;

function json(status: number, body: CompressUploadResponse) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function decodeBase64ToBytes(base64: string): Uint8Array {
  if (!BASE64_REGEX.test(base64)) {
    throw new Error("Invalid base64 payload");
  }
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

function encodeBytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

async function optimizePdf(input: Uint8Array): Promise<Uint8Array> {
  const doc = await PDFDocument.load(input);
  const bytes = await doc.save({
    useObjectStreams: true,
    addDefaultPage: false,
    updateFieldAppearances: false,
  });
  return bytes;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { ok: false, errorCode: "COMPRESSION_FAILED", message: "Method not allowed" });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) return json(500, { ok: false, errorCode: "COMPRESSION_FAILED", message: "Server misconfiguration" });

    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return json(401, { ok: false, errorCode: "UNAUTHORIZED", message: "Missing authorization token" });
    }
    const jwt = authHeader.replace("Bearer ", "");

    const body = (await req.json()) as CompressUploadRequest;
    const fileName = String(body.file_name || "upload.bin").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 160);
    const mimeType = (body.mime_type || "").toLowerCase();
    const fileBase64 = body.file_base64 || "";
    const targetBytes = Math.max(1, Number(body.target_bytes || 0));
    const absoluteCap = Math.max(1, Number(body.absolute_cap_bytes || 2 * 1024 * 1024));

    if (!ALLOWED_MIME.has(mimeType)) {
      return json(400, { ok: false, errorCode: "UNSUPPORTED_TYPE", message: "Unsupported file type" });
    }

    const serviceClient = createClient(supabaseUrl, serviceRoleKey);
    const { data: authData, error: authError } = await serviceClient.auth.getUser(jwt);
    if (authError || !authData.user) return json(401, { ok: false, errorCode: "UNAUTHORIZED", message: "Invalid token" });

    const { data: membership } = await serviceClient
      .from("organization_memberships")
      .select("organization_id")
      .eq("user_id", authData.user.id)
      .eq("is_active", true)
      .limit(1);
    if (!membership?.length) return json(403, { ok: false, errorCode: "UNAUTHORIZED", message: "Organization membership required" });

    const inputBytes = decodeBase64ToBytes(fileBase64);
    if (inputBytes.length > MAX_INPUT_BYTES) {
      return json(400, { ok: false, errorCode: "INPUT_TOO_LARGE", message: "Input file too large" });
    }

    let outputBytes = inputBytes;
    const warnings: string[] = [];
    let strategy = "passthrough";

    if (mimeType === "application/pdf") {
      try {
        outputBytes = await Promise.race([
          optimizePdf(inputBytes),
          new Promise<Uint8Array>((_, reject) => setTimeout(() => reject(new Error("timeout")), 12000)),
        ]);
        strategy = "pdf-optimize";
      } catch (e: any) {
        if (e?.message === "timeout") {
          return json(408, { ok: false, errorCode: "TIMEOUT", message: "Compression timeout" });
        }
        warnings.push("pdf-optimize-failed-using-original");
        outputBytes = inputBytes;
      }
    } else {
      warnings.push("server-image-compression-not-available-used-original");
    }

    // never return larger than input when optimizing
    if (outputBytes.length > inputBytes.length) {
      outputBytes = inputBytes;
      warnings.push("optimized-output-larger-used-original");
    }

    // hard cap
    if (outputBytes.length > absoluteCap || outputBytes.length > Math.max(targetBytes, absoluteCap)) {
      return json(400, {
        ok: false,
        errorCode: "COMPRESSION_FAILED",
        message: "Compressed file still exceeds allowed size",
      });
    }

    const ratio = outputBytes.length / Math.max(1, inputBytes.length);

    // When the client requests server-side upload (images, to bypass browser→storage issues),
    // upload directly from the edge function using the service-role client.
    if (body.upload_to_temp) {
      const storagePath = `temp/${authData.user.id}/${fileName}`;
      const { error: uploadError } = await serviceClient.storage
        .from("receipts")
        .upload(storagePath, outputBytes, { contentType: mimeType, upsert: true });

      if (uploadError) {
        return json(500, { ok: false, errorCode: "COMPRESSION_FAILED", message: `Server upload failed: ${uploadError.message}` });
      }

      const { data: urlData } = serviceClient.storage.from("receipts").getPublicUrl(storagePath);
      return json(200, {
        ok: true,
        file_name: fileName,
        mime_type: mimeType,
        storage_path: storagePath,
        public_url: urlData.publicUrl,
        originalSize: inputBytes.length,
        compressedSize: outputBytes.length,
        ratio,
        strategy,
        warnings,
      });
    }

    return json(200, {
      ok: true,
      file_name: fileName,
      mime_type: mimeType,
      compressed_base64: encodeBytesToBase64(outputBytes),
      originalSize: inputBytes.length,
      compressedSize: outputBytes.length,
      ratio,
      strategy,
      warnings,
    });
  } catch (e: any) {
    return json(500, {
      ok: false,
      errorCode: "COMPRESSION_FAILED",
      message: e?.message || "Unexpected compression failure",
    });
  }
});
