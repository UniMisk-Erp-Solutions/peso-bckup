import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Copy, Trash2 } from "lucide-react";
import { BatchCategoryField } from "@/components/BatchCategoryField";
import { BatchLineReceiptSection } from "@/components/BatchLineReceiptSection";
import { BaseExpenseFieldInput } from "@/components/BaseExpenseFieldInput";
import { NumberInput } from "@/components/NumberInput";
import { formatINR } from "@/lib/format";
import { lineRequiresReceipt } from "@/lib/expenseBatchValidation";
import type { BatchLineInput } from "@/lib/expenseBatchValidation";
import type { TempUploadMeta } from "@/lib/expenseBatchAttachments";
import { BATCH_EXPENSE_MIN_LINES } from "@/lib/expenseBatchConstants";
import {
  DEFAULT_BASE_FIELD_CONFIG,
  type BaseExpenseFieldKey,
  type BaseFieldConfig,
} from "@/lib/expenseFormConfig";
import { Badge } from "@/components/ui/badge";

type BatchExpenseLinesTableProps = {
  lines: BatchLineInput[];
  categories: string[];
  recommendedCategories: string[];
  attachmentLimit: number;
  attachmentMode: "per_line" | "shared";
  sharedDestination: string;
  sharedTitle?: string;
  showCategory: boolean;
  categoryLabel: string;
  categoryRequired: boolean;
  titleLabel: string;
  titleRequired?: boolean;
  amountLabel: string;
  showPurpose: boolean;
  purposeLabel: string;
  purposeRequired: boolean;
  showDestination: boolean;
  destinationLabel: string;
  getReceiptCount: (clientId: string) => number;
  onUpdateLine: (clientId: string, patch: Partial<BatchLineInput>) => void;
  onDuplicate: (index: number) => void;
  onRemove: (clientId: string) => void;
  onReceiptUpload: (clientId: string, path: string, meta: TempUploadMeta) => void;
  baseFieldConfig?: Record<BaseExpenseFieldKey, BaseFieldConfig>;
  baseFieldCustomizationEnabled?: boolean;
  organizationId?: string | null;
  userId?: string | null;
};

export function BatchExpenseLinesTable({
  lines,
  categories,
  recommendedCategories,
  attachmentLimit,
  attachmentMode,
  sharedDestination,
  sharedTitle,
  showCategory,
  categoryLabel,
  categoryRequired,
  titleLabel,
  titleRequired = false,
  amountLabel,
  showPurpose,
  purposeLabel,
  purposeRequired,
  showDestination,
  destinationLabel,
  getReceiptCount,
  onUpdateLine,
  onDuplicate,
  onRemove,
  onReceiptUpload,
  baseFieldConfig,
  baseFieldCustomizationEnabled = false,
  organizationId,
  userId,
}: BatchExpenseLinesTableProps) {
  const fieldConfig = (key: BaseExpenseFieldKey): BaseFieldConfig =>
    baseFieldConfig?.[key] ?? DEFAULT_BASE_FIELD_CONFIG[key];
  return (
    <div className="rounded-md border overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-10">#</TableHead>
            {showCategory && <TableHead className="min-w-[180px]">{categoryLabel}</TableHead>}
            {sharedTitle === undefined && <TableHead className="min-w-[120px]">{titleLabel}</TableHead>}
            <TableHead className="min-w-[100px]">{amountLabel}</TableHead>
            {showPurpose && <TableHead className="min-w-[160px]">{purposeLabel}</TableHead>}
            {showDestination && !sharedDestination.trim() && (
              <TableHead className="min-w-[120px]">{destinationLabel}</TableHead>
            )}
            {attachmentMode === "per_line" && (
              <TableHead className="min-w-[100px]">Bill</TableHead>
            )}
            <TableHead className="w-20 text-right"> </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {lines.map((line, index) => {
            const receiptCount = getReceiptCount(line.clientId);
            const needsReceipt = lineRequiresReceipt(Number(line.amount) || 0, attachmentLimit);
            return (
              <TableRow key={line.clientId} className="align-top">
                <TableCell className="font-medium text-muted-foreground">{index + 1}</TableCell>
                {showCategory && (
                  <TableCell>
                    <BatchCategoryField
                      compact
                      label={categoryLabel}
                      required={categoryRequired}
                      value={line.category}
                      categories={categories}
                      recommendedCategories={recommendedCategories}
                      onChange={(v) => onUpdateLine(line.clientId, { category: v })}
                    />
                  </TableCell>
                )}
                {sharedTitle === undefined && (
                  <TableCell>
                    <BaseExpenseFieldInput
                      config={fieldConfig("title")}
                      placeholder={titleRequired ? `${titleLabel} *` : titleLabel}
                      value={line.title}
                      onChange={(v) => onUpdateLine(line.clientId, { title: v })}
                      featureEnabled={baseFieldCustomizationEnabled}
                      organizationId={organizationId}
                      userId={userId}
                      defaultControl={
                        <Input
                          className="h-9"
                          value={line.title}
                          onChange={(e) => onUpdateLine(line.clientId, { title: e.target.value })}
                          placeholder={titleRequired ? `${titleLabel} *` : titleLabel}
                        />
                      }
                    />
                  </TableCell>
                )}
                <TableCell>
                  <BaseExpenseFieldInput
                    config={fieldConfig("amount")}
                    value={line.amount ? String(line.amount) : ""}
                    onChange={(v) =>
                      onUpdateLine(line.clientId, { amount: parseFloat(v) || 0 })
                    }
                    featureEnabled={baseFieldCustomizationEnabled}
                    organizationId={organizationId}
                    userId={userId}
                    defaultControl={
                      <NumberInput
                        className="h-9"
                        min={0}
                        step="0.01"
                        value={line.amount || ""}
                        onChange={(e) =>
                          onUpdateLine(line.clientId, {
                            amount: parseFloat(e.target.value) || 0,
                          })
                        }
                      />
                    }
                  />
                </TableCell>
                {showPurpose && (
                  <TableCell>
                    <BaseExpenseFieldInput
                      config={fieldConfig("purpose")}
                      placeholder={purposeRequired ? `${purposeLabel} *` : purposeLabel}
                      value={line.purpose || ""}
                      onChange={(v) => onUpdateLine(line.clientId, { purpose: v })}
                      featureEnabled={baseFieldCustomizationEnabled}
                      organizationId={organizationId}
                      userId={userId}
                      defaultControl={
                        <Textarea
                          className="min-h-[60px] text-sm"
                          value={line.purpose || ""}
                          onChange={(e) => onUpdateLine(line.clientId, { purpose: e.target.value })}
                          placeholder={purposeRequired ? `${purposeLabel} *` : purposeLabel}
                          rows={2}
                        />
                      }
                    />
                  </TableCell>
                )}
                {showDestination && !sharedDestination.trim() && (
                  <TableCell>
                    <BaseExpenseFieldInput
                      config={fieldConfig("destination")}
                      placeholder={destinationLabel}
                      value={line.destination || ""}
                      onChange={(v) => onUpdateLine(line.clientId, { destination: v })}
                      featureEnabled={baseFieldCustomizationEnabled}
                      organizationId={organizationId}
                      userId={userId}
                      defaultControl={
                        <Input
                          className="h-9"
                          placeholder={destinationLabel}
                          value={line.destination || ""}
                          onChange={(e) =>
                            onUpdateLine(line.clientId, { destination: e.target.value })
                          }
                        />
                      }
                    />
                  </TableCell>
                )}
                {attachmentMode === "per_line" && (
                  <TableCell>
                    {needsReceipt ? (
                      receiptCount > 0 ? (
                        <Badge variant="outline" className="bg-green-50 text-green-800">
                          {receiptCount} file{receiptCount > 1 ? "s" : ""}
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="bg-amber-50 text-amber-900">
                          Required
                        </Badge>
                      )
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                )}
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => onDuplicate(index)}
                    >
                      <Copy className="h-4 w-4" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      disabled={lines.length <= BATCH_EXPENSE_MIN_LINES}
                      onClick={() => onRemove(line.clientId)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>

      {attachmentMode === "per_line" && (
        <div className="p-4 space-y-4 border-t bg-muted/20">
          <p className="text-sm font-medium">Bill uploads by line</p>
          <div className="grid gap-4 sm:grid-cols-2">
            {lines.map((line, index) => {
              const needsReceipt = lineRequiresReceipt(Number(line.amount) || 0, attachmentLimit);
              if (!needsReceipt && getReceiptCount(line.clientId) === 0) return null;
              return (
                <div key={`receipt-${line.clientId}`} className="rounded border bg-background p-3">
                  <p className="text-xs font-medium mb-2">
                    Line {index + 1}: {line.title || "Untitled"} · {formatINR(line.amount)}
                  </p>
                  <BatchLineReceiptSection
                    compact
                    amount={Number(line.amount) || 0}
                    attachmentLimit={attachmentLimit}
                    receiptCount={getReceiptCount(line.clientId)}
                    onUpload={(path, meta) => onReceiptUpload(line.clientId, path, meta)}
                  />
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
