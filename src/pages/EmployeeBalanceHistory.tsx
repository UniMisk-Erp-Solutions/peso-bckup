import { useEffect, useMemo, useState } from "react";
import { Navigate } from "react-router-dom";
import { format } from "date-fns";
import { ArrowDownToLine, RefreshCw, Wallet } from "lucide-react";
import { useTranslation } from "@/i18n";
import { useAuth } from "@/contexts/AuthContext";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ListPagination } from "@/components/ListPagination";
import { clampPage, getTotalPages } from "@/lib/listPagination";
import { formatINR } from "@/lib/format";
import { getDateLocale } from "@/lib/formatLocale";
import { useViewportMode } from "@/hooks/useViewportMode";
import {
  useEmployeeBalanceHistory,
  type BalanceCreditRow,
} from "@/hooks/useEmployeeBalanceHistory";

const DEFAULT_PAGE_SIZE = 25;

/**
 * Balance History — deliberately NOT a complete ledger.
 *
 * PesoWise deducts approved expenses from `profiles.balance` on a separate path,
 * so the credits listed here do not sum to the current balance and the page never
 * claims they do. Current balance comes from the authoritative AuthContext value;
 * it is never derived from this list.
 */
export default function EmployeeBalanceHistory() {
  const { t, i18n } = useTranslation(["transfers", "common"]);
  const { userRole, userBalance, refreshBalance } = useAuth();
  const { isMobile } = useViewportMode();
  const moneyLocale = getDateLocale(i18n.language);

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);

  const { featureEnabled, data, isLoading, isError, isFetching, refetch } =
    useEmployeeBalanceHistory(page, pageSize);

  // Records can change between renders (a new credit lands, an admin backdates a
  // row). Clamp so the view never sits on a page that no longer exists.
  useEffect(() => {
    const clamped = clampPage(page, data.totalCount, pageSize);
    if (clamped !== page) setPage(clamped);
  }, [page, pageSize, data.totalCount]);

  const lastCredit = useMemo<BalanceCreditRow | null>(
    () => (page === 1 && data.rows.length > 0 ? data.rows[0]! : null),
    [page, data.rows],
  );

  /**
   * Legacy rows: migration 20260420130500 backfilled NULL → 'cash' and made the
   * column NOT NULL, so nulls should not reach the UI. We still refuse to label
   * an unknown value "Cash" — inventing a payment method on someone's financial
   * record is worse than admitting it was not recorded.
   */
  const paymentModeLabel = (mode: string | null) => {
    if (mode === "bank_transfer") return t("transfers:balanceHistory.bankTransfer");
    if (mode === "cash") return t("transfers:balanceHistory.cash");
    return t("transfers:balanceHistory.notRecorded");
  };

  const creditedByLabel = (name: string | null) =>
    name?.trim() ? name : t("transfers:balanceHistory.systemCredit");

  const formatDate = (iso: string) => format(new Date(iso), "d MMM yyyy");

  // Feature off → no data request was made (the hook stays disabled) and the
  // employee simply goes back to the dashboard. No premium teaser, no shell.
  if (!featureEnabled) {
    return <Navigate to="/dashboard" replace />;
  }

  // Defence in depth: ProtectedRoute already restricts this route to employees.
  if (userRole !== "employee") {
    return <Navigate to="/dashboard" replace />;
  }

  const handleRefresh = () => {
    void refetch();
    void refreshBalance();
  };

  const totalPages = getTotalPages(data.totalCount, pageSize);

  const summaryCards = (
    <div className="grid gap-3 sm:gap-4 grid-cols-1 sm:grid-cols-2">
      <Card className="border-2 border-green-200 bg-gradient-to-br from-green-50 to-emerald-50">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium text-green-700">
            {t("transfers:balanceHistory.currentBalance")}
          </CardTitle>
          <Wallet className="h-4 w-4 text-green-600" />
        </CardHeader>
        <CardContent>
          <div className="text-xl sm:text-2xl font-bold text-green-800">
            {formatINR(userBalance ?? 0, moneyLocale)}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">
            {t("transfers:balanceHistory.lastCredit")}
          </CardTitle>
          <ArrowDownToLine className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          {lastCredit ? (
            <>
              <div className="text-xl sm:text-2xl font-bold text-green-700">
                +{formatINR(lastCredit.amount, moneyLocale)}
              </div>
              <p className="text-xs sm:text-sm mt-1 text-muted-foreground">
                {formatDate(lastCredit.transferred_at)}
              </p>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t("transfers:balanceHistory.noLastCredit")}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );

  const creditsBody = () => {
    if (isLoading) {
      return (
        <div className="flex items-center justify-center py-8">
          <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
        </div>
      );
    }

    if (isError) {
      return (
        <div className="py-8 text-center space-y-3">
          <p className="text-sm text-muted-foreground">
            {t("transfers:balanceHistory.loadError")}
          </p>
          <Button variant="outline" size="sm" onClick={handleRefresh}>
            <RefreshCw className="h-4 w-4 mr-2" />
            {t("transfers:balanceHistory.retry")}
          </Button>
        </div>
      );
    }

    if (data.rows.length === 0) {
      return (
        <p className="text-center text-muted-foreground py-8">
          {t("transfers:balanceHistory.noCredits")}
        </p>
      );
    }

    if (isMobile) {
      return (
        <div className="divide-y divide-border">
          {data.rows.map((row) => (
            <div key={row.id} className="py-3 space-y-1" data-testid="credit-row">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-base font-semibold text-green-700">
                  +{formatINR(row.amount, moneyLocale)}
                </span>
                <span className="text-xs text-muted-foreground shrink-0">
                  {formatDate(row.transferred_at)}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <Badge variant="secondary">{paymentModeLabel(row.payment_mode)}</Badge>
                <span className="truncate">{creditedByLabel(row.credited_by_name)}</span>
              </div>
            </div>
          ))}
        </div>
      );
    }

    return (
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="whitespace-nowrap">
                {t("transfers:balanceHistory.date")}
              </TableHead>
              <TableHead className="whitespace-nowrap">
                {t("transfers:balanceHistory.amountCredited")}
              </TableHead>
              <TableHead className="whitespace-nowrap">
                {t("transfers:balanceHistory.paymentMethod")}
              </TableHead>
              <TableHead className="whitespace-nowrap">
                {t("transfers:balanceHistory.creditedBy")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.rows.map((row) => (
              <TableRow key={row.id} data-testid="credit-row">
                <TableCell className="whitespace-nowrap">
                  {formatDate(row.transferred_at)}
                </TableCell>
                <TableCell className="font-semibold text-green-700 whitespace-nowrap">
                  +{formatINR(row.amount, moneyLocale)}
                </TableCell>
                <TableCell>
                  <Badge variant="secondary">{paymentModeLabel(row.payment_mode)}</Badge>
                </TableCell>
                <TableCell className="max-w-[220px] truncate">
                  {creditedByLabel(row.credited_by_name)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    );
  };

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">
            {t("transfers:balanceHistory.pageTitle")}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {t("transfers:balanceHistory.pageDescription")}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={handleRefresh}
          disabled={isFetching}
          className="whitespace-nowrap self-start"
        >
          <RefreshCw className={`h-4 w-4 mr-2 ${isFetching ? "animate-spin" : ""}`} />
          {t("common:refresh")}
        </Button>
      </div>

      {summaryCards}

      <Card>
        <CardHeader>
          <CardTitle className="text-base sm:text-lg">
            {t("transfers:balanceHistory.recentCredits")}
          </CardTitle>
          <CardDescription>
            {t("transfers:balanceHistory.expenseHistoryNote")}
          </CardDescription>
        </CardHeader>
        <CardContent className="px-3 sm:px-6">{creditsBody()}</CardContent>
        {!isLoading && !isError && data.totalCount > 0 && totalPages > 0 && (
          <ListPagination
            page={page}
            pageSize={pageSize}
            totalItems={data.totalCount}
            onPageChange={setPage}
            onPageSizeChange={(size) => {
              setPageSize(size);
              setPage(1);
            }}
          />
        )}
      </Card>
    </div>
  );
}
