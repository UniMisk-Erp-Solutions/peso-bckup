import { useState, useRef, useEffect } from "react";
import { truncateFilenameForMobile } from "@/lib/truncateFilename";
import { supabase } from "@/integrations/supabase/client";
import { removeAttachmentSafely } from "@/lib/attachmentRemoval";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { AttachmentPreviewDialog } from "@/components/AttachmentPreviewDialog";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Upload, X, FileText, Image, Download, Camera, Eye } from "lucide-react";
import { cn } from "@/lib/utils";
import { format } from "date-fns";
import { useIsMobile } from "@/hooks/use-mobile";
import { isStandaloneDisplayMode } from "@/lib/pwa";
import { compressUploadFile, shouldUseServerFallback } from "@/lib/uploadCompression";
import { isAllowedUploadMime, resolveUploadMimeType } from "@/lib/uploadMimeType";
import { useTranslation } from "react-i18next";

interface Attachment {
  id: string;
  filename: string;
  content_type: string;
  file_url: string;
  created_at: string;
  file_size?: number; // File size in bytes
  /** Object name under `temp/{userId}/` or `{expenseId}/` in the receipts bucket */
  storage_path?: string;
}

type ReceiptUploadState = "queued" | "uploading" | "uploaded" | "failed";

interface FailedUpload {
  id: string;
  file: File;
  filename: string;
  errorMessage: string;
  state: ReceiptUploadState;
}

interface FileUploadProps {
  expenseId: string;
  lineItemId?: string;
  /** Called synchronously before opening file/camera picker (save form draft on mobile). */
  onBeforePickerOpen?: () => void;
  onUploadComplete?: (attachment: Attachment, blob?: Blob) => void;
  onUploadError?: (error: string) => void;
  className?: string;
  required?: boolean;
  /** Force mobile UX: camera/file buttons full-width with 44px tap targets. */
  variant?: "mobile";
}

export function FileUpload({
  expenseId,
  lineItemId,
  onBeforePickerOpen,
  onUploadComplete,
  onUploadError,
  className,
  required = false,
  variant,
}: FileUploadProps) {
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadStatus, setUploadStatus] = useState<string>("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [imagePreviewOpen, setImagePreviewOpen] = useState(false);
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null);
  const [previewContentType, setPreviewContentType] = useState<string | null>(null);
  const [previewFilename, setPreviewFilename] = useState<string | undefined>(undefined);
  const totalSizeRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const dragCounterRef = useRef(0);
  const [isDragOver, setIsDragOver] = useState(false);
  const [failedUploads, setFailedUploads] = useState<FailedUpload[]>([]);
  const { toast } = useToast();
  const { t } = useTranslation("common");
  const { user, organizationId } = useAuth();
  const isMobile = useIsMobile();
  const showCameraCapture = variant === "mobile" || isMobile || isStandaloneDisplayMode();
  const forceMobileLayout = variant === "mobile" || isMobile;
  const MAX_TOTAL_SIZE = 50 * 1024 * 1024;

  const getTotalSize = (list: Attachment[]) =>
    list.reduce((sum, att) => sum + (att.file_size || 0), 0);

  // Load existing attachments when expenseId is provided (not "new")
  useEffect(() => {
    const loadAttachments = async () => {
      if (expenseId && expenseId !== "new" && organizationId) {
        try {
          const { data, error } = await supabase
            .from('attachments')
            .select('*')
            .eq('expense_id', expenseId)
            .eq('organization_id', organizationId)
            .order('created_at', { ascending: false });

          if (error) {
            console.error('Error loading attachments:', error);
            return;
          }

          if (data && data.length > 0) {
            // Map data to include file_size (default to 0 if not available)
            const attachmentsWithSize = data.map((att) => ({
              ...att,
              file_size: att.file_size || 0
            }));
            setAttachments(attachmentsWithSize);
            totalSizeRef.current = getTotalSize(attachmentsWithSize);
            console.log('✅ Loaded existing attachments:', attachmentsWithSize.length);
          } else {
            totalSizeRef.current = 0;
          }
        } catch (error) {
          console.error('Error fetching attachments:', error);
          totalSizeRef.current = 0;
        }
      }
    };

    loadAttachments();
  }, [expenseId, organizationId]);


  const notifyBeforePicker = () => {
    onBeforePickerOpen?.();
  };

  const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files || files.length === 0) return;

    await processFiles(files);

    if (event.target) {
      event.target.value = '';
    }
  };

  const processFiles = async (files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      if (!file.size) continue;
      await uploadFile(file);
    }
  };

  const handleDragEnter = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (uploading) return;
    dragCounterRef.current += 1;
    setIsDragOver(true);
  };

  const handleDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    dragCounterRef.current -= 1;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
      setIsDragOver(false);
    }
  };

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const handleDrop = async (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    dragCounterRef.current = 0;
    setIsDragOver(false);
    if (uploading) return;

    notifyBeforePicker();
    const files = event.dataTransfer.files;
    if (!files || files.length === 0) return;

    await processFiles(files);
  };

  const openFilePicker = () => {
    notifyBeforePicker();
    requestAnimationFrame(() => fileInputRef.current?.click());
  };

  const handleCameraClick = () => {
    notifyBeforePicker();
    requestAnimationFrame(() => cameraInputRef.current?.click());
  };

  const bytesToBase64 = (bytes: Uint8Array) => {
    const chunkSize = 0x8000;
    let binary = "";
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, i + chunkSize);
      binary += String.fromCharCode.apply(null, Array.from(chunk));
    }
    return btoa(binary);
  };

  // Image compression removed as requested

  // PDF compression removed as requested

  const uploadFile = async (file: File) => {
    try {
      setUploading(true);
      setUploadProgress(0);
      setUploadStatus(t("uploadFile.preparing"));

      // Calculate current total size of all attachments - 2MB combined limit
      const currentTotalSize = totalSizeRef.current;

      const remainingBudget = Math.max(0, MAX_TOTAL_SIZE - currentTotalSize);

      const resolvedMime = resolveUploadMimeType(file);

      if (!isAllowedUploadMime(resolvedMime)) {
        throw new Error("Only PNG, JPG image files and PDF files are allowed for bill uploads");
      }

      const fileExtension = file.name.includes(".")
        ? file.name.toLowerCase().substring(file.name.lastIndexOf("."))
        : "";
      if (fileExtension) {
        const allowedExtensions = [".png", ".jpg", ".jpeg", ".heic", ".heif", ".pdf"];
        if (!allowedExtensions.includes(fileExtension)) {
          throw new Error("Only PNG/JPG/HEIC image files and PDF files are allowed for bill uploads");
        }
      }

      const uploadFileName =
        file.name && file.name !== "image" && file.name.includes(".")
          ? file.name
          : resolvedMime === "application/pdf"
            ? `receipt-${Date.now()}.pdf`
            : `receipt-${Date.now()}.jpg`;

      setUploadProgress(10);
      setUploadStatus(t("uploadFile.uploading"));

      if (!user?.id) {
        throw new Error(t("uploadFile.mustLogin"));
      }

      // Create unique filename
      const fileExt = uploadFileName.split(".").pop() || "jpg";
      const fileName = `${Date.now()}-${Math.random().toString(36).substring(2)}.${fileExt}`;
      const uploadPath = expenseId === "new" || !expenseId ? `temp/${user?.id}/${fileName}` : `${expenseId}/${fileName}`;
      const bucketName = 'receipts';

      // Size check
      if (currentTotalSize + file.size > MAX_TOTAL_SIZE) {
        const maxMB = (MAX_TOTAL_SIZE / (1024 * 1024)).toFixed(0);
        throw new Error(`File too large (${(file.size / (1024 * 1024)).toFixed(1)} MB). Max total is ${maxMB} MB.`);
      }

      setUploadProgress(30);

      const uploadResult = await supabase.storage
        .from('receipts')
        .upload(uploadPath, file, { cacheControl: '3600', upsert: true });

      if (uploadResult.error) {
        throw new Error(`Failed to upload file: ${uploadResult.error.message}`);
      }

      setUploadProgress(70);

      const fileToUpload = file;
      const publicUrl = supabase.storage.from(bucketName).getPublicUrl(uploadPath).data.publicUrl;

      setUploadProgress(85);

      // Save attachment record to database (only if expenseId is not "new")
      let attachmentData = null;
      if (expenseId !== "new" && expenseId) {
        if (!organizationId) {
          throw new Error("Organization not found");
        }

        const { data, error: attachmentError } = await supabase
          .from('attachments')
          .insert({
            expense_id: expenseId,
            organization_id: organizationId,
            line_item_id: lineItemId,
            file_url: publicUrl,
            filename: file.name,
            content_type: fileToUpload.type,
            uploaded_by: user?.id,
            file_size: fileToUpload.size,
            storage_path: uploadPath,
          })
          .select()
          .single();

        if (attachmentError) {
          console.error('❌ Database insert error:', attachmentError);
          throw attachmentError;
        }
        attachmentData = data
          ? { ...data, storage_path: fileName }
          : data;
      }

      setUploadProgress(100);

      // Create a temporary attachment object for new expenses
      const tempAttachment = {
        id: `temp-${Date.now()}-${fileName}`,
        filename: file.name,
        content_type: fileToUpload.type,
        file_url: publicUrl,
        created_at: new Date().toISOString(),
        file_size: fileToUpload.size,
        storage_path: fileName,
      };

      setAttachments(prev => [...prev, attachmentData || tempAttachment]);
      totalSizeRef.current += fileToUpload.size;

      toast({
        title: t("uploadFile.success"),
        description:
          fileToUpload.size < file.size
            ? `${file.name} compressed ${formatFileSize(file.size)} -> ${formatFileSize(fileToUpload.size)}`
            : `${file.name} uploaded (${formatFileSize(fileToUpload.size)})`,
      });

      if (onUploadComplete) {
        onUploadComplete(attachmentData || tempAttachment, fileToUpload);
      }
    } catch (error: any) {
      console.error("Upload error:", error);
      const errorMessage = error.message || t("uploadFile.uploadFailedHint");

      const failedId = `failed-${Date.now()}-${Math.random().toString(36).substring(2)}`;
      setFailedUploads((prev) => [
        ...prev,
        { id: failedId, file, filename: file.name || "receipt", errorMessage, state: "failed" as ReceiptUploadState },
      ]);

      toast({
        variant: "destructive",
        title: t("uploadFile.failed"),
        description: errorMessage,
      });

      onUploadError?.(errorMessage);
    } finally {
      setUploading(false);
      setUploadProgress(0);
      setUploadStatus("");
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const retryUpload = async (failedUpload: FailedUpload) => {
    setFailedUploads((prev) => prev.filter((f) => f.id !== failedUpload.id));
    await uploadFile(failedUpload.file);
  };

  const deleteAttachment = async (attachmentId: string) => {
    try {
      const attachment = attachments.find(a => a.id === attachmentId);
      if (!attachment) return;

      // Extract file path from URL
      // Handle both public URLs and paths
      let filePath = '';
      if (attachment.file_url.startsWith('http')) {
        const url = new URL(attachment.file_url);
        // Extract path after /storage/v1/object/public/receipts/
        const pathMatch = url.pathname.match(/\/storage\/v1\/object\/public\/receipts\/(.+)$/);
        if (pathMatch) {
          filePath = pathMatch[1];
        } else {
          // Fallback: try to extract from pathname
          const parts = url.pathname.split('/');
          const receiptsIndex = parts.indexOf('receipts');
          if (receiptsIndex !== -1 && receiptsIndex < parts.length - 1) {
            filePath = parts.slice(receiptsIndex + 1).join('/');
          }
        }
      } else {
        // If it's already a path
        filePath = attachment.file_url;
      }

      // NOTE (DOC-078): the storage object is deliberately NOT deleted here.
      // This call used to be `storage.from('receipts').remove([filePath])`, which is the
      // exact operation that destroyed the receipt in DOC-077 §5d — an unversioned bucket,
      // no staging twin, gone in 3m47s. Removal is now metadata-only, so a mistaken tap is
      // always recoverable and a metadata failure can never destroy bytes.
      // `filePath` is still resolved above for the audit trail only.
      void filePath;
      await removeAttachmentSafely(supabase, {
        attachmentId,
        source: 'file_upload_component',
      });

      // Remove from local state
      setAttachments(prev => prev.filter(a => a.id !== attachmentId));
      totalSizeRef.current = Math.max(0, totalSizeRef.current - (attachment.file_size || 0));

      toast({
        title: t("uploadFile.deleted"),
        description: t("uploadFile.deletedHint", { name: attachment.filename }),
      });
    } catch (error: any) {
      console.error("❌ Delete error:", error);
      toast({
        variant: "destructive",
        title: t("uploadFile.deleteFailed"),
        description: error.message || t("uploadFile.deleteFailedHint"),
      });
    }
  };

  const getFileIcon = (contentType: string) => {
    if (contentType.startsWith('image/')) {
      return <Image className="h-4 w-4" />;
    }
    if (contentType === 'application/pdf') {
      return <FileText className="h-4 w-4" />;
    }
    return <FileText className="h-4 w-4" />;
  };

  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  return (
    <>
      <Card className={cn("w-full", className)}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Upload className="h-5 w-5" />
            {t("uploadFile.cardTitle")}
          </CardTitle>
          <CardDescription>
            {t("uploadFile.cardDescription")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Upload Area */}
          <div
            className={cn(
              "border-2 border-dashed rounded-lg p-6 text-center transition-colors",
              isDragOver
                ? "border-primary bg-primary/5 ring-2 ring-primary/20"
                : "border-muted-foreground/25",
              uploading && "opacity-70",
              forceMobileLayout && "min-w-0 w-full max-w-full",
            )}
            onDragEnter={handleDragEnter}
            onDragLeave={handleDragLeave}
            onDragOver={handleDragOver}
            onDrop={(event) => void handleDrop(event)}
          >
            {/* Regular file input for desktop */}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/png,image/jpeg,image/jpg,image/heic,image/heif,application/pdf"
              onPointerDown={notifyBeforePicker}
              onTouchStart={notifyBeforePicker}
              onFocus={notifyBeforePicker}
              onChange={handleFileSelect}
              className="hidden"
            />

            {/* Camera input for mobile */}
            <input
              ref={cameraInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              onPointerDown={notifyBeforePicker}
              onTouchStart={notifyBeforePicker}
              onFocus={notifyBeforePicker}
              onChange={handleFileSelect}
              className="hidden"
            />

            <div className="space-y-2">
              <Upload
                className={cn(
                  "h-8 w-8 mx-auto transition-colors",
                  isDragOver ? "text-primary" : "text-muted-foreground",
                )}
              />
              {isDragOver ? (
                <p className="text-sm font-medium text-primary">{t("uploadFile.dropActiveHint")}</p>
              ) : (
                <>
                  <div className="flex flex-col sm:flex-row gap-2 justify-center items-center">
                    <Button
                      variant="outline"
                      onPointerDown={notifyBeforePicker}
                      onTouchStart={notifyBeforePicker}
                      onClick={openFilePicker}
                      disabled={uploading}
                      className={cn("w-full sm:w-auto", forceMobileLayout && "min-h-[44px]")}
                    >
                      <Upload className="h-4 w-4 mr-2" />
                      {t("uploadFile.chooseFiles")}
                    </Button>
                    {showCameraCapture && (
                      <Button
                        variant="outline"
                        onPointerDown={notifyBeforePicker}
                        onTouchStart={notifyBeforePicker}
                        onClick={handleCameraClick}
                        disabled={uploading}
                        className={cn("w-full sm:w-auto bg-blue-50 hover:bg-blue-100 border-blue-300", forceMobileLayout && "min-h-[44px]")}
                      >
                        <Camera className="h-4 w-4 mr-2" />
                        {t("uploadFile.takePhoto")}
                      </Button>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground mt-2">
                    {showCameraCapture ? t("uploadFile.dropHintMobile") : t("uploadFile.dropHintDesktop")}
                  </p>
                </>
              )}
              <p className="text-xs text-muted-foreground">
                {t("uploadFile.fileTypesHint")}
                {required && (
                  <span className="text-red-500 font-medium"> * {t("uploadFile.requiredForSubmission")}</span>
                )}
              </p>
            </div>

            {uploading && (
              <div className="mt-4 space-y-2">
                <Progress value={uploadProgress} className="w-full" />
                <p className="text-sm text-muted-foreground">{uploadStatus || t("uploadFile.uploadingProgress")}</p>
              </div>
            )}
          </div>

          {/* Failed Uploads — shown with retry button; never call onUploadComplete for these */}
          {failedUploads.length > 0 && (
            <div className="space-y-2">
              <h4 className="font-medium text-destructive text-sm">Failed uploads</h4>
              <div className="space-y-2">
                {failedUploads.map((failed) => (
                  <div
                    key={failed.id}
                    data-testid="failed-upload-item"
                    className="flex items-center justify-between p-3 border border-destructive/30 rounded-lg bg-destructive/5"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <FileText className="h-4 w-4 text-destructive shrink-0" />
                      <div className="min-w-0">
                        <p className="font-medium text-sm truncate">{failed.filename}</p>
                        <p className="text-xs text-destructive truncate">{failed.errorMessage}</p>
                      </div>
                    </div>
                    <Button
                      data-testid="retry-upload-button"
                      variant="outline"
                      size="sm"
                      onClick={() => void retryUpload(failed)}
                      disabled={uploading}
                      className="shrink-0 ml-2"
                    >
                      Retry
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Attachments List */}
          {attachments.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <h4 className="font-medium">{t("uploadFile.uploadedFiles")}</h4>
                <p className="text-xs text-muted-foreground">
                  {t("uploadFile.totalSize", {
                    current: formatFileSize(attachments.reduce((sum, att) => sum + (att.file_size || 0), 0)),
                    max: formatFileSize(MAX_TOTAL_SIZE),
                  })}
                </p>
              </div>
              <div className="space-y-2">
                {attachments.filter(attachment => attachment).map((attachment) => (
                  <div
                    key={attachment.id || attachment.file_url}
                    className={cn("flex items-center justify-between p-3 border rounded-lg", forceMobileLayout && "min-w-0 w-full max-w-full")}
                  >
                    <div className="flex items-center gap-3 min-w-0 flex-1">
                      {getFileIcon(attachment.content_type || 'image/jpeg')}
                      <div className="min-w-0 flex-1">
                        <p className="font-medium text-sm truncate" title={attachment.filename || undefined}>
                          {attachment.filename
                            ? (forceMobileLayout ? truncateFilenameForMobile(attachment.filename, 20) : attachment.filename)
                            : t("uploadFile.unknownFile")}
                        </p>
                        <p className={cn("text-xs text-muted-foreground", forceMobileLayout && "truncate")}>
                          {attachment.content_type || t("uploadFile.unknownType")} • {attachment.file_size ? formatFileSize(attachment.file_size) : t("uploadFile.unknownSize")} • {(() => {
                            try {
                              return attachment.created_at ? format(new Date(attachment.created_at), "MMM d, yyyy") : t("uploadFile.unknownDate");
                            } catch {
                              return t("uploadFile.invalidDate");
                            }
                          })()}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setImagePreviewUrl(attachment.file_url);
                          setPreviewContentType(attachment.content_type);
                          setPreviewFilename(attachment.filename);
                          setImagePreviewOpen(true);
                        }}
                      >
                        <Eye className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => deleteAttachment(attachment.id)}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <AttachmentPreviewDialog
        open={imagePreviewOpen}
        onOpenChange={setImagePreviewOpen}
        url={imagePreviewUrl}
        contentType={previewContentType}
        filename={previewFilename}
        enableImageZoom
      />
    </>
  );
}

