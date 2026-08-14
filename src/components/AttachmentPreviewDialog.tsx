import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Download,
  ExternalLink,
  FileImage,
  ImageOff,
  Loader2,
  Maximize2,
  RotateCcw,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  isPdfAttachment,
  resolveImagePreviewSource,
  resolvePdfPreviewObjectUrl,
  type ImagePreviewStatus,
} from "@/lib/attachmentPreview";

export type AttachmentPreviewDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  url: string | null;
  contentType?: string | null;
  filename?: string;
  title?: string;
  description?: string;
  /** When set, retry preview from temp/{userId}/ if the permanent expense path is missing. */
  uploadedBy?: string | null;
  /** When set, retry preview from {expenseId}/ if the stored path still points at temp/. */
  expenseId?: string | null;
  /** Enable zoom controls for image previews (upload flow). */
  enableImageZoom?: boolean;
};

export function AttachmentPreviewDialog({
  open,
  onOpenChange,
  url,
  contentType,
  filename,
  title,
  description,
  uploadedBy,
  // Declared in the props type and read below, but never destructured until
  // 2026-08-03. `expenseId` was therefore a FREE identifier at runtime: the
  // minifier left the name un-renamed (its signature for a global), and opening
  // a receipt preview on /expenses/new threw
  //   ReferenceError: expenseId is not defined
  // straight into the ErrorBoundary (GlitchTip PESOWISE-WEB-KF).
  expenseId,
  enableImageZoom = false,
}: AttachmentPreviewDialogProps) {
  const { t } = useTranslation("common");
  const [imageZoom, setImageZoom] = useState(1);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  // The untouched original. For HEIC this is NOT what <img> renders (that is a converted
  // JPEG), but it is what Download and Open in new tab must hand the user.
  const [originalUrl, setOriginalUrl] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewStatus, setPreviewStatus] = useState<ImagePreviewStatus>("ok");
  const blobUrlsRef = useRef<string[]>([]);

  const releaseBlobUrls = () => {
    for (const candidate of blobUrlsRef.current) {
      if (candidate.startsWith("blob:")) URL.revokeObjectURL(candidate);
    }
    blobUrlsRef.current = [];
  };

  const trackBlobUrl = (candidate: string | null) => {
    if (candidate?.startsWith("blob:") && !blobUrlsRef.current.includes(candidate)) {
      blobUrlsRef.current.push(candidate);
    }
  };

  const handleOpenChange = (next: boolean) => {
    if (!next) setImageZoom(1);
    onOpenChange(next);
  };

  const isPdf = url ? isPdfAttachment(url, contentType) : false;

  useEffect(() => {
    if (!open || !url) {
      releaseBlobUrls();
      setPreviewUrl(null);
      setOriginalUrl(null);
      setPreviewLoading(false);
      setPreviewStatus("ok");
      return;
    }

    let cancelled = false;
    setPreviewLoading(true);
    setPreviewStatus("ok");
    releaseBlobUrls();
    setPreviewUrl(null);
    setOriginalUrl(null);

    const resolvePreview = isPdf
      ? resolvePdfPreviewObjectUrl(url, contentType, {
          fallbackTempUserId: uploadedBy,
          fallbackExpenseId: expenseId,
        }).then((objectUrl) => ({
          status: (objectUrl ? "ok" : "missing") as ImagePreviewStatus,
          objectUrl,
          originalObjectUrl: objectUrl,
        }))
      : resolveImagePreviewSource(url, contentType, {
          fallbackTempUserId: uploadedBy,
          fallbackExpenseId: expenseId,
        });

    void resolvePreview
      .then((result) => {
        if (cancelled) {
          for (const candidate of [result.objectUrl, result.originalObjectUrl]) {
            if (candidate?.startsWith("blob:")) URL.revokeObjectURL(candidate);
          }
          return;
        }
        trackBlobUrl(result.objectUrl);
        trackBlobUrl(result.originalObjectUrl);
        setPreviewUrl(result.objectUrl);
        setOriginalUrl(result.originalObjectUrl);
        setPreviewStatus(result.status);
      })
      .catch(() => {
        if (!cancelled) setPreviewStatus("missing");
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });

    return () => {
      cancelled = true;
    };
  // expenseId belongs here: it is the fallback used to retry a stale temp/ path,
  // so a change to it must re-resolve the preview. It was absent only because
  // the identifier used to resolve to a global, which the linter could not see.
  }, [open, url, contentType, isPdf, uploadedBy, expenseId]);

  useEffect(() => {
    return () => {
      releaseBlobUrls();
    };
  }, []);

  if (!url) {
    // Radix requires a DialogTitle/DialogDescription (or an explicit
    // aria-describedby={undefined}) on every DialogContent — an entirely
    // empty one warns/errors at runtime even though nothing is visibly
    // wrong. This state is reachable whenever `open` and `url` are two
    // independent pieces of caller state that can briefly disagree (e.g. an
    // attachment record with no file_url).
    return (
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="max-w-5xl w-[95vw]">
          <DialogHeader>
            <DialogTitle className="sr-only">{title ?? t("attachmentPreview.title")}</DialogTitle>
            <DialogDescription className="sr-only">
              {description ?? t("attachmentPreview.imageDescription")}
            </DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    );
  }

  const displayTitle = title ?? t("attachmentPreview.title");
  const displayDescription =
    description ??
    (isPdf ? t("attachmentPreview.pdfDescription") : t("attachmentPreview.imageDescription"));

  const zoomIn = () => setImageZoom((z) => Math.min(4, Number((z + 0.25).toFixed(2))));
  const zoomOut = () => setImageZoom((z) => Math.max(0.25, Number((z - 0.25).toFixed(2))));
  const resetZoom = () => setImageZoom(1);
  const fitToScreen = () => setImageZoom(1);

  const effectiveSrc = previewUrl;
  // Prefer the original: for HEIC the renderable source is a converted JPEG, but a user
  // opening the attachment in its own tab should get the real file they uploaded.
  const newTabSrc = originalUrl || previewUrl;
  const downloadSrc = originalUrl || previewUrl;
  const openPreviewInNewTab = () => {
    const target = newTabSrc || url;
    if (target) window.open(target, "_blank", "noopener,noreferrer");
  };

  const unavailableBlock = (
    <div className="flex h-[min(72vh,320px)] flex-col items-center justify-center gap-3 rounded-md border bg-muted/40 px-4 text-center">
      <ImageOff className="h-10 w-10 text-muted-foreground" />
      <p className="text-sm text-muted-foreground">{t("attachmentPreview.fileUnavailable")}</p>
      <p className="text-xs text-muted-foreground max-w-md">
        {t("attachmentPreview.fileUnavailableHint")}
      </p>
    </div>
  );

  // The file downloaded fine, this browser just cannot paint it. Say that instead of
  // claiming the receipt was lost, and put the escape hatch right where the image failed.
  const unsupportedBlock = (
    <div className="flex h-[min(72vh,320px)] flex-col items-center justify-center gap-3 rounded-md border bg-muted/40 px-4 text-center">
      <FileImage className="h-10 w-10 text-muted-foreground" />
      <p className="text-sm text-muted-foreground">
        {t("attachmentPreview.formatUnsupported", {
          defaultValue: "This image format can't be displayed in this browser.",
        })}
      </p>
      <p className="text-xs text-muted-foreground max-w-md">
        {t("attachmentPreview.formatUnsupportedHint", {
          defaultValue:
            "The file is intact — HEIC/HEIF photos from iPhone cannot be shown inline here. Open it in a new tab or download it to view.",
        })}
      </p>
      {newTabSrc ? (
        <Button type="button" variant="default" size="sm" onClick={openPreviewInNewTab}>
          <ExternalLink className="mr-2 h-4 w-4" />
          {t("attachmentPreview.openInNewTab", { defaultValue: "Open in new tab" })}
        </Button>
      ) : null}
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-5xl w-[95vw] max-h-[92vh] flex flex-col gap-3 p-4 sm:p-6">
        <DialogHeader className="shrink-0">
          <DialogTitle>{displayTitle}</DialogTitle>
          <DialogDescription>{displayDescription}</DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-auto">
          {previewLoading ? (
            <div className="flex h-[min(72vh,820px)] flex-col items-center justify-center gap-3 rounded-md border bg-muted/40">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                {isPdf
                  ? t("attachmentPreview.pdfLoading", { defaultValue: "Loading PDF…" })
                  : t("attachmentPreview.imageLoading", { defaultValue: "Loading image…" })}
              </p>
            </div>
          ) : previewStatus === "unsupported" ? (
            unsupportedBlock
          ) : previewStatus === "missing" || !effectiveSrc ? (
            unavailableBlock
          ) : isPdf ? (
            <div className="space-y-3">
              <iframe
                src={`${effectiveSrc}#view=FitH`}
                title={filename || t("attachmentPreview.pdfFrameTitle")}
                className="h-[min(72vh,820px)] w-full rounded-md border bg-muted"
              />
            </div>
          ) : enableImageZoom ? (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm text-muted-foreground">
                  {t("uploadFile.zoomLevel", { percent: Math.round(imageZoom * 100) })}
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={zoomOut}>
                    <ZoomOut className="mr-1 h-4 w-4" />
                    {t("uploadFile.zoomOut")}
                  </Button>
                  <Button type="button" variant="outline" size="sm" onClick={zoomIn}>
                    <ZoomIn className="mr-1 h-4 w-4" />
                    {t("uploadFile.zoomIn")}
                  </Button>
                  <Button type="button" variant="outline" size="sm" onClick={fitToScreen}>
                    <Maximize2 className="mr-1 h-4 w-4" />
                    {t("uploadFile.fit")}
                  </Button>
                  <Button type="button" variant="outline" size="sm" onClick={resetZoom}>
                    <RotateCcw className="mr-1 h-4 w-4" />
                    {t("uploadFile.reset")}
                  </Button>
                </div>
              </div>
              <div
                className="h-[min(72vh,820px)] w-full overflow-auto rounded-md border bg-muted/30"
                onWheel={(e) => {
                  if (!e.ctrlKey) return;
                  e.preventDefault();
                  if (e.deltaY < 0) zoomIn();
                  else zoomOut();
                }}
              >
                <div className="flex min-h-full min-w-full items-center justify-center p-4">
                  <img
                    src={effectiveSrc}
                    alt={filename || t("uploadFile.previewAlt")}
                    className="select-none rounded shadow-sm"
                    style={{
                      transform: `scale(${imageZoom})`,
                      transformOrigin: "center center",
                      transition: "transform 0.15s ease-out",
                      maxWidth: imageZoom <= 1 ? "100%" : "none",
                      height: "auto",
                    }}
                    draggable={false}
                    // We already hold the bytes, so a decode failure here is a format the
              // browser cannot paint — never "the file is gone".
              onError={() => setPreviewStatus("unsupported")}
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">{t("uploadFile.zoomTip")}</p>
            </div>
          ) : (
            <img
              src={effectiveSrc}
              alt={filename || t("uploadFile.previewAlt")}
              className="mx-auto max-h-[min(72vh,820px)] w-full rounded-md object-contain"
              // We already hold the bytes, so a decode failure here is a format the
              // browser cannot paint — never "the file is gone".
              onError={() => setPreviewStatus("unsupported")}
            />
          )}
        </div>

        <div className="flex shrink-0 flex-wrap gap-2 border-t pt-3">
          {/* Offered for images too, not just PDFs: it is the fallback route to any file
              this browser refuses to render inline (HEIC being the common case). */}
          {newTabSrc ? (
            <Button type="button" variant="outline" onClick={openPreviewInNewTab}>
              <ExternalLink className="mr-2 h-4 w-4" />
              {t("attachmentPreview.openInNewTab", { defaultValue: "Open in new tab" })}
            </Button>
          ) : null}
          {downloadSrc ? (
            <Button type="button" variant="outline" asChild>
              <a href={downloadSrc} download={filename || undefined} rel="noopener noreferrer">
                <Download className="mr-2 h-4 w-4" />
                {t("attachmentPreview.download")}
              </a>
            </Button>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
