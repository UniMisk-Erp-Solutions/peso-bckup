import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { blurFocusedNumberInputOnWheel } from "@/lib/numberInputWheel";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ExpenseCategorySelect } from "@/components/ExpenseCategorySelect";
import { Loader2 } from "lucide-react";
import { CorrectionCustomFieldsSection } from "@/components/CorrectionCustomFieldsSection";
import type { CorrectionCustomFieldsModel } from "@/lib/loadCorrectionCustomFields";

type Props = {
  organizationId: string | null | undefined;
  corrTitle: string;
  setCorrTitle: (v: string) => void;
  corrDestination: string;
  setCorrDestination: (v: string) => void;
  corrExpenseDate: string;
  setCorrExpenseDate: (v: string) => void;
  corrPurpose: string;
  setCorrPurpose: (v: string) => void;
  corrCategory: string;
  setCorrCategory: (v: string) => void;
  corrAmount: string;
  setCorrAmount: (v: string) => void;
  corrAdminComment: string;
  setCorrAdminComment: (v: string) => void;
  correctionReason: string;
  setCorrectionReason: (v: string) => void;
  corrFieldModel: CorrectionCustomFieldsModel;
  onCorrFormFieldValuesChange: (vals: Record<string, string>) => void;
  onCorrBranchValuesChange: (vals: Record<string, string>) => void;
  allowNested?: boolean;
  loading: boolean;
  onSubmit: () => void;
  onCancel: () => void;
};

export function MobileCorrectionFields({
  organizationId,
  corrTitle, setCorrTitle,
  corrDestination, setCorrDestination,
  corrExpenseDate, setCorrExpenseDate,
  corrPurpose, setCorrPurpose,
  corrCategory, setCorrCategory,
  corrAmount, setCorrAmount,
  corrAdminComment, setCorrAdminComment,
  correctionReason, setCorrectionReason,
  corrFieldModel,
  onCorrFormFieldValuesChange,
  onCorrBranchValuesChange,
  allowNested,
  loading,
  onSubmit,
  onCancel,
}: Props) {
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50/50 p-4 space-y-3">
      <p className="text-xs text-amber-800 font-medium">
        Correct expense — saves an audit record. Employee still sees it as in review.
      </p>

      <div>
        <Label htmlFor="mob-corr-title" className="text-xs">Title</Label>
        <Input id="mob-corr-title" value={corrTitle} onChange={(e) => setCorrTitle(e.target.value)} className="mt-1" />
      </div>
      <div>
        <Label htmlFor="mob-corr-dest" className="text-xs">Destination</Label>
        <Input id="mob-corr-dest" value={corrDestination} onChange={(e) => setCorrDestination(e.target.value)} className="mt-1" />
      </div>
      <div>
        <Label htmlFor="mob-corr-date" className="text-xs">Date of expense</Label>
        <Input id="mob-corr-date" type="date" value={corrExpenseDate} onChange={(e) => setCorrExpenseDate(e.target.value)} className="mt-1" />
      </div>
      <div>
        <Label htmlFor="mob-corr-pur" className="text-xs">Purpose</Label>
        <Textarea id="mob-corr-pur" value={corrPurpose} onChange={(e) => setCorrPurpose(e.target.value)} rows={2} className="mt-1" />
      </div>
      <div>
        <Label htmlFor="mob-corr-cat" className="text-xs">Category</Label>
        <div className="mt-1">
          <ExpenseCategorySelect
            id="mob-corr-cat"
            organizationId={organizationId}
            value={corrCategory}
            onChange={setCorrCategory}
          />
        </div>
      </div>
      <div>
        <Label htmlFor="mob-corr-amt" className="text-xs">Total amount</Label>
        <Input id="mob-corr-amt" type="number" min={0} step="0.01" inputMode="decimal" onWheelCapture={blurFocusedNumberInputOnWheel} value={corrAmount} onChange={(e) => setCorrAmount(e.target.value)} className="mt-1" />
      </div>
      <div>
        <Label htmlFor="mob-corr-ac" className="text-xs">Admin comment</Label>
        <Textarea id="mob-corr-ac" value={corrAdminComment} onChange={(e) => setCorrAdminComment(e.target.value)} rows={2} className="mt-1" />
      </div>
      <CorrectionCustomFieldsSection
        categoryFormFields={corrFieldModel.categoryFormFields}
        formFieldValues={corrFieldModel.formFieldValues}
        onFormFieldValuesChange={onCorrFormFieldValuesChange}
        optionBranches={corrFieldModel.optionBranches}
        branchValues={corrFieldModel.branchValues}
        onBranchValuesChange={onCorrBranchValuesChange}
        allowNested={allowNested}
        organizationId={organizationId}
      />
      <div>
        <Label htmlFor="mob-corr-reason" className="text-xs">Reason for correction (audit)</Label>
        <Textarea id="mob-corr-reason" value={correctionReason} onChange={(e) => setCorrectionReason(e.target.value)} rows={2} className="mt-1" />
      </div>

      <div className="flex gap-2 pt-1">
        <Button variant="outline" size="sm" onClick={onCancel} disabled={loading} className="flex-1 min-h-[44px]">
          Cancel
        </Button>
        <Button size="sm" onClick={onSubmit} disabled={loading} className="flex-1 min-h-[44px]">
          {loading ? <><Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />Saving…</> : "Save correction"}
        </Button>
      </div>
    </div>
  );
}
