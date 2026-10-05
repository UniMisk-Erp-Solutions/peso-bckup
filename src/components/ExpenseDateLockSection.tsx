import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Lock, Plus, Unlock } from "lucide-react";
import { fetchExpenseDateLocks, type ExpenseDateLock } from "@/lib/expenseDateLocks";

// create_expense_date_lock_v1 / deactivate_expense_date_lock_v1 are new
// (20261018100000_expense_date_locking_v1.sql) and not yet in the generated
// Supabase types -- same established cast used in src/lib/expenseDateLocks.ts.
const db = supabase as any;

/** First/last calendar day of a yyyy-MM value, as yyyy-MM-dd strings. */
function monthToRange(monthValue: string): { from: string; to: string } | null {
  const match = /^(\d{4})-(\d{2})$/.exec(monthValue);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]); // 1-12
  const from = `${match[1]}-${match[2]}-01`;
  const lastDay = new Date(year, month, 0).getDate(); // day 0 of next month = last day of this month
  const to = `${match[1]}-${match[2]}-${String(lastDay).padStart(2, "0")}`;
  return { from, to };
}

function formatRangeDate(value: string): string {
  // value is yyyy-MM-dd; render as a locale date without a timezone-shift
  // risk from `new Date("yyyy-MM-dd")` (parsed as UTC midnight).
  const [y, m, d] = value.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

/**
 * Org-admin UI for managing expense date locks. Only rendered by Settings
 * when expense_date_locking is enabled for this organization (Master Admin
 * controlled, same convention as every other ORGANIZATION_FEATURE_KEYS
 * entry -- this component does not duplicate that toggle).
 */
export function ExpenseDateLockSection() {
  const { t } = useTranslation("settings");
  const { organizationId } = useAuth();
  const { toast } = useToast();
  const [locks, setLocks] = useState<ExpenseDateLock[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [monthShortcut, setMonthShortcut] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [reason, setReason] = useState("");

  const refresh = async () => {
    if (!organizationId) return;
    setLoading(true);
    const rows = await fetchExpenseDateLocks(organizationId);
    setLocks(rows);
    setLoading(false);
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizationId]);

  const handleMonthShortcut = (value: string) => {
    setMonthShortcut(value);
    const range = monthToRange(value);
    if (range) {
      setDateFrom(range.from);
      setDateTo(range.to);
    }
  };

  const handleCreateLock = async () => {
    if (!organizationId || !dateFrom || !dateTo) return;
    if (dateFrom > dateTo) {
      toast({
        variant: "destructive",
        title: t("expenseDateLock.invalidRangeTitle"),
        description: t("expenseDateLock.invalidRangeDescription"),
      });
      return;
    }
    setSaving(true);
    const { error } = await db.rpc("create_expense_date_lock_v1", {
      p_organization_id: organizationId,
      p_date_from: dateFrom,
      p_date_to: dateTo,
      p_reason: reason.trim() || null,
    });
    setSaving(false);
    if (error) {
      toast({ variant: "destructive", title: t("expenseDateLock.lockFailedTitle"), description: error.message });
      return;
    }
    toast({
      title: t("expenseDateLock.lockedToastTitle"),
      description: t("expenseDateLock.lockedToastDescription", {
        from: formatRangeDate(dateFrom),
        to: formatRangeDate(dateTo),
      }),
    });
    setMonthShortcut("");
    setDateFrom("");
    setDateTo("");
    setReason("");
    await refresh();
  };

  const handleDeactivate = async (lock: ExpenseDateLock) => {
    setSaving(true);
    const { error } = await db.rpc("deactivate_expense_date_lock_v1", { p_lock_id: lock.id });
    setSaving(false);
    if (error) {
      toast({ variant: "destructive", title: t("expenseDateLock.unlockFailedTitle"), description: error.message });
      return;
    }
    toast({ title: t("expenseDateLock.unlockedToastTitle") });
    await refresh();
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Lock className="h-5 w-5" />
          <CardTitle>{t("expenseDateLock.title")}</CardTitle>
        </div>
        <CardDescription>{t("expenseDateLock.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-3 rounded-md border p-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="expense-date-lock-month">{t("expenseDateLock.month")}</Label>
              <Input
                id="expense-date-lock-month"
                type="month"
                value={monthShortcut}
                onChange={(e) => handleMonthShortcut(e.target.value)}
              />
            </div>
            <div />
            <div className="space-y-2">
              <Label htmlFor="expense-date-lock-from">{t("expenseDateLock.fromDate")}</Label>
              <Input
                id="expense-date-lock-from"
                type="date"
                value={dateFrom}
                onChange={(e) => {
                  setMonthShortcut("");
                  setDateFrom(e.target.value);
                }}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="expense-date-lock-to">{t("expenseDateLock.toDate")}</Label>
              <Input
                id="expense-date-lock-to"
                type="date"
                value={dateTo}
                onChange={(e) => {
                  setMonthShortcut("");
                  setDateTo(e.target.value);
                }}
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="expense-date-lock-reason">{t("expenseDateLock.reason")}</Label>
            <Input
              id="expense-date-lock-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t("expenseDateLock.reasonPlaceholder")}
            />
          </div>
          <Button
            onClick={() => void handleCreateLock()}
            disabled={saving || !dateFrom || !dateTo}
          >
            <Plus className="mr-2 h-4 w-4" />
            {t("expenseDateLock.lockDates")}
          </Button>
        </div>

        <div className="space-y-2">
          <h4 className="text-sm font-medium">{t("expenseDateLock.lockedRanges")}</h4>
          {loading ? (
            <p className="text-sm text-muted-foreground">{t("expenseDateLock.loading")}</p>
          ) : locks.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("expenseDateLock.empty")}</p>
          ) : (
            <div className="space-y-2">
              {locks.map((lock) => (
                <div
                  key={lock.id}
                  className="flex flex-col gap-2 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div>
                    <p className="text-sm font-medium">
                      {formatRangeDate(lock.date_from)} — {formatRangeDate(lock.date_to)}
                    </p>
                    {lock.reason && <p className="text-sm text-muted-foreground">{lock.reason}</p>}
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={lock.is_active ? "default" : "secondary"}>
                      {lock.is_active ? t("expenseDateLock.active") : t("expenseDateLock.inactive")}
                    </Badge>
                    {lock.is_active && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={saving}
                        onClick={() => void handleDeactivate(lock)}
                      >
                        <Unlock className="mr-2 h-4 w-4" />
                        {t("expenseDateLock.unlock")}
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
