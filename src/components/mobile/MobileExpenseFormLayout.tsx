import type { ReactNode } from "react";

type Props = { active: boolean; children: ReactNode };

export function MobileExpenseFormLayout({ active, children }: Props) {
  if (!active) return <>{children}</>;
  return <div className="mobile-expense-form-layout">{children}</div>;
}
