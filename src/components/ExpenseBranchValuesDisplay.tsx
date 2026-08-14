import { ExpenseFormFieldsDisplay } from "@/components/ExpenseFormFieldsDisplay";

type ExpenseBranchValuesDisplayProps = {
  expenseId: string;
  organizationId: string;
  className?: string;
};

/** Shows template + conditional branch custom fields on review/detail views. */
export function ExpenseBranchValuesDisplay({
  expenseId,
  organizationId,
  className,
}: ExpenseBranchValuesDisplayProps) {
  return (
    <ExpenseFormFieldsDisplay
      expenseId={expenseId}
      organizationId={organizationId}
      context="review"
      className={className}
    />
  );
}
