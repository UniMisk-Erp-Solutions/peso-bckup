/** MIME types accepted for expense receipt uploads. */
export const ALLOWED_UPLOAD_MIMES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/heic",
  "image/heif",
  "application/pdf",
]);

const EXT_TO_MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".pdf": "application/pdf",
};

/**
 * iOS Safari and installed PWAs often return an empty `file.type` for camera
 * captures. Infer a usable MIME from the extension or sensible defaults.
 */
export function resolveUploadMimeType(file: File): string {
  const raw = file.type?.trim().toLowerCase();
  if (raw && raw !== "application/octet-stream") {
    return raw === "image/jpg" ? "image/jpeg" : raw;
  }

  const name = file.name?.toLowerCase() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot !== -1) {
    const ext = name.slice(dot);
    const fromExt = EXT_TO_MIME[ext];
    if (fromExt) return fromExt;
  }

  // Camera captures on iOS frequently have no extension and no MIME.
  if (file.size > 0) return "image/jpeg";

  return raw || "application/octet-stream";
}

export function isAllowedUploadMime(mime: string): boolean {
  const normalized = mime === "image/jpg" ? "image/jpeg" : mime;
  return ALLOWED_UPLOAD_MIMES.has(normalized);
}

export function isAllowedUploadFile(file: File): boolean {
  return isAllowedUploadMime(resolveUploadMimeType(file));
}
