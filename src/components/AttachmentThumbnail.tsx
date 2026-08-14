import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ImageOff, Loader2 } from "lucide-react";
import {
  isImageAttachment,
  isReceiptKnownMissing,
  resolveImagePreviewObjectUrl,
} from "@/lib/attachmentPreview";
import { cn } from "@/lib/utils";

type AttachmentThumbnailProps = {
  fileUrl: string;
  contentType?: string | null;
  alt?: string;
  className?: string;
  uploadedBy?: string | null;
  /** When set, retry from {expenseId}/ if the stored path still points at temp/. */
  expenseId?: string | null;
};

export function AttachmentThumbnail({
  fileUrl,
  contentType,
  alt,
  className,
  uploadedBy,
  expenseId,
}: AttachmentThumbnailProps) {
  const { t } = useTranslation("common");
  const isImage = isImageAttachment(fileUrl, contentType);
  const renderable = isImage && !isReceiptKnownMissing(fileUrl);
  const [displaySrc, setDisplaySrc] = useState<string | null>(renderable ? fileUrl : null);
  const [status, setStatus] = useState<"loading" | "ready" | "failed">(
    renderable ? "loading" : "failed",
  );
  const [usedFallback, setUsedFallback] = useState(false);
  const blobUrlRef = useRef<string | null>(null);

  useEffect(() => {
    if (!isImage || !fileUrl || isReceiptKnownMissing(fileUrl)) {
      setStatus("failed");
      setDisplaySrc(null);
      return;
    }

    setDisplaySrc(fileUrl);
    setUsedFallback(false);
    setStatus("loading");

    return () => {
      if (blobUrlRef.current?.startsWith("blob:")) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    };
  }, [fileUrl, contentType, isImage]);

  const handleError = () => {
    if (!isImage || usedFallback) {
      setStatus("failed");
      return;
    }

    setUsedFallback(true);
    void resolveImagePreviewObjectUrl(fileUrl, contentType, {
      fallbackTempUserId: uploadedBy,
      fallbackExpenseId: expenseId,
    }).then((resolved) => {
      if (resolved) {
        if (resolved.startsWith("blob:")) blobUrlRef.current = resolved;
        setDisplaySrc(resolved);
        setStatus("ready");
      } else {
        setStatus("failed");
      }
    });
  };

  if (!isImage || status === "failed") {
    return (
      <div
        className={cn(
          "flex flex-col items-center justify-center gap-0.5 bg-muted text-muted-foreground rounded text-[10px] leading-tight text-center px-1",
          className,
        )}
        title={t("attachmentPreview.fileUnavailable")}
      >
        <ImageOff className="h-4 w-4 shrink-0" />
        <span className="line-clamp-2">{t("attachmentPreview.unavailableShort")}</span>
      </div>
    );
  }

  return (
    <div className={cn("relative overflow-hidden rounded", className)}>
      {status === "loading" ? (
        <div className="absolute inset-0 flex items-center justify-center bg-muted">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
      ) : null}
      {displaySrc ? (
        <img
          src={displaySrc}
          alt={alt || t("uploadFile.previewAlt")}
          className="h-full w-full object-cover"
          onLoad={() => setStatus("ready")}
          onError={handleError}
        />
      ) : null}
    </div>
  );
}
