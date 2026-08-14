import { FileUpload } from "@/components/FileUpload";
import { Label } from "@/components/ui/label";
import { formatINR } from "@/lib/format";
import type { TempUploadMeta } from "@/lib/expenseBatchAttachments";

type BatchLineReceiptSectionProps = {
  amount: number;
  attachmentLimit: number;
  receiptCount: number;
  onUpload: (storagePath: string, meta: TempUploadMeta) => void;
  compact?: boolean;
};

export function BatchLineReceiptSection({
  amount,
  attachmentLimit,
  receiptCount,
  onUpload,
  compact = false,
}: BatchLineReceiptSectionProps) {
  const required = amount > attachmentLimit;

  return (
    <div className={compact ? "space-y-1" : "space-y-2 pt-2 border-t"}>
      <Label className={compact ? "text-xs" : undefined}>
        Bill photos
        {required ? (
          <span className="text-red-500 font-normal ml-1">* Required</span>
        ) : (
          <span className="text-muted-foreground font-normal ml-1">(optional)</span>
        )}
      </Label>
      {!compact && (
        <p className="text-xs text-muted-foreground">
          {required
            ? `Required for amounts above ${formatINR(attachmentLimit)}.`
            : `Optional for amounts up to ${formatINR(attachmentLimit)}.`}
        </p>
      )}
      <FileUpload
        expenseId="new"
        required={required}
        onUploadComplete={(attachment) => {
          if (
            attachment?.storage_path &&
            typeof attachment.id === "string" &&
            attachment.id.startsWith("temp-")
          ) {
            onUpload(attachment.storage_path, {
              filename: attachment.filename,
              file_size: attachment.file_size ?? 0,
              content_type: attachment.content_type || "image/jpeg",
            });
          }
        }}
      />
      {required && receiptCount > 0 && (
        <p className="text-xs text-green-600 font-medium">
          ✓ {receiptCount} bill photo{receiptCount > 1 ? "s" : ""} uploaded
        </p>
      )}
      {required && receiptCount === 0 && (
        <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1">
          Upload at least one bill for amounts above {formatINR(attachmentLimit)}.
        </p>
      )}
    </div>
  );
}
