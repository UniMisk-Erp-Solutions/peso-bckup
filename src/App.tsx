import { Suspense } from "react";
import { lazyWithRetry } from "@/lib/lazyWithRetry";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { SystemAlertBanner } from "@/components/SystemAlertBanner";
import { SYSTEM_STATUS_CONTROL_ENABLED } from "@/config/systemStatusFeature";
import { SystemUnavailableScreen } from "@/components/SystemUnavailableScreen";
import { useSystemAvailability } from "@/contexts/SystemAvailabilityContext";
import { ScrollToTop } from "@/components/ScrollToTop";
import { RouteAnalytics } from "@/components/RouteAnalytics";
import { PlausibleAnalytics } from "@/components/PlausibleAnalytics";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { SessionExpiredNotice } from "@/components/SessionExpiredNotice";
import { TenantHostRedirect } from "@/components/TenantHostRedirect";
import { Layout } from "@/components/Layout";
import { PageLoadingSkeleton } from "@/components/PageLoadingSkeleton";
import Auth from "./pages/Auth";
import { PwtFeatureGate } from "./components/PwtFeatureGate";
import HomePage from "./pages/marketing/HomePage";
import Dashboard from "./pages/Dashboard";
import Expenses from "./pages/Expenses";
import ExpenseForm from "./pages/ExpenseForm";
import ExpenseDetail from "./pages/ExpenseDetail";
import Notifications from "./pages/Notifications";
import NotFound from "./pages/NotFound";

// Performance: pages that are not needed for the first screen load on demand, so the
// initial download stays small. Behaviour, routes and role checks are unchanged — the
// only difference is a brief page skeleton the first time one of these is opened.
// Public marketing / legal pages (the home page stays eager: it is the landing page).
const FeaturesPage = lazyWithRetry(() => import("./pages/FeaturesPage"));
const HowItWorksPage = lazyWithRetry(() => import("./pages/HowItWorksPage"));
const SecurityPage = lazyWithRetry(() => import("./pages/SecurityPage"));
const PricingPage = lazyWithRetry(() => import("./pages/PricingPage"));
const ContactPage = lazyWithRetry(() => import("./pages/ContactPage"));
const PrivacyPage = lazyWithRetry(() => import("./pages/legal/PrivacyPage"));
const CookiePolicyPage = lazyWithRetry(() => import("./pages/legal/CookiePolicyPage"));
const TermsPage = lazyWithRetry(() => import("./pages/legal/TermsPage"));
const DisclaimerPage = lazyWithRetry(() => import("./pages/legal/DisclaimerPage"));
const DataProcessingPolicy = lazyWithRetry(() => import("./pages/legal/DataProcessingPolicy"));
const UserActivityInsightsNotice = lazyWithRetry(() => import("./pages/legal/UserActivityInsightsNotice"));
const DataRightsAndGrievance = lazyWithRetry(() => import("./pages/legal/DataRightsAndGrievance"));
// App pages used less often than Dashboard / Expenses / the expense form.
const ExpenseBatchForm = lazyWithRetry(() => import("./pages/ExpenseBatchForm"));
const BatchExpenseReview = lazyWithRetry(() => import("./pages/BatchExpenseReview"));
// ReviewExpenses pulls in EngineerReview (the largest page, ~5.5k lines).
const ReviewExpenses = lazyWithRetry(() => import("./pages/ReviewExpenses"));
const TransferOffers = lazyWithRetry(() => import("./pages/TransferOffers"));
const NotificationSettings = lazyWithRetry(() => import("./pages/NotificationSettings"));
const HelpTutorial = lazyWithRetry(() => import("./pages/HelpTutorial"));

const AdminPanel = lazyWithRetry(() => import("./pages/AdminPanel"));
const AdminSubmitExpense = lazyWithRetry(() => import("./pages/AdminSubmitExpense"));
const UserManagement = lazyWithRetry(() => import("./pages/UserManagement"));
const Balances = lazyWithRetry(() => import("./pages/Balances"));
const Reports = lazyWithRetry(() => import("./pages/Reports"));
const AdminPwTally = lazyWithRetry(() => import("./pages/AdminPwTally"));
const Settings = lazyWithRetry(() => import("./pages/Settings"));
const Analytics = lazyWithRetry(() => import("./pages/Analytics"));
const CategoryManagement = lazyWithRetry(() => import("./pages/CategoryManagement"));
const MasterAdminDashboard = lazyWithRetry(() => import("./pages/MasterAdminDashboard"));
const CashierTransactions = lazyWithRetry(() => import("./pages/CashierTransactions"));
const CashTransferHistory = lazyWithRetry(() => import("./pages/CashTransferHistory"));
const AccountantApprovedExpenses = lazyWithRetry(() => import("./pages/AccountantApprovedExpenses"));
const EmployeeBalanceHistory = lazyWithRetry(() => import("./pages/EmployeeBalanceHistory"));
const MyTeams = lazyWithRetry(() => import("./pages/MyTeams"));
const TeamReports = lazyWithRetry(() => import("./pages/TeamReports"));
const MyReports = lazyWithRetry(() => import("./pages/MyReports"));
const UserActivityInsights = lazyWithRetry(() => import("./pages/UserActivityInsights"));
const UserAudit = lazyWithRetry(() => import("./pages/UserAudit"));
// Independent debug validation surface (DOC-080). Additive: /review is unchanged.

function LazyPage({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<PageLoadingSkeleton />}>{children}</Suspense>;
}
import { PwaHead } from "@/components/PwaHead";
import { DashboardThemeApplier } from "@/components/DashboardThemeApplier";
import { PwaInstallPrompt } from "@/components/PwaInstallPrompt";
import {
  EXPENSE_REVIEW_ROLES,
  EXPENSE_SUBMITTER_ROLES,
  STANDARD_APP_ROLES,
} from "@/lib/routeAccess";

/**
 * Mounts SystemAlertBanner once globally above all routes when the feature is
 * enabled. When disabled, renders children only — no banner, no requests.
 * Placed inside BrowserRouter so it can use useLocation if needed.
 */
function GlobalSystemStatusShell({ children }: { children: React.ReactNode }) {
  return (
    <>
      {SYSTEM_STATUS_CONTROL_ENABLED ? <SystemAlertBanner /> : null}
      {children}
    </>
  );
}

// AuthMaintenanceGate removed: /auth must always be reachable so that
// Master Admin (and any user who needs to log in) can access the sign-in
// form during maintenance. Blocking non-admin users after login is handled
// by ProtectedRoute once the session is established.

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000,
      retry: 1,
      // Don't re-hit the API just because the user switched tabs and came back, or the
      // network blipped. Data still loads on mount/navigation, via realtime, and on
      // explicit refresh — this only removes the redundant refetch storms.
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    },
  },
});

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <DashboardThemeApplier />
      <PwaHead />
      <Toaster />
      <Sonner />
      <SessionExpiredNotice />
      <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <PwaInstallPrompt />
        <ScrollToTop />
        <RouteAnalytics />
        <PlausibleAnalytics />
        <GlobalSystemStatusShell>
        <Routes>
          <Route path="/auth" element={<Auth />} />
          <Route element={<TenantHostRedirect />}>
            <Route path="/" element={<HomePage />} />
            <Route path="/features" element={<LazyPage><FeaturesPage /></LazyPage>} />
            <Route path="/how-it-works" element={<LazyPage><HowItWorksPage /></LazyPage>} />
            <Route path="/security" element={<LazyPage><SecurityPage /></LazyPage>} />
            <Route path="/pricing" element={<LazyPage><PricingPage /></LazyPage>} />
            <Route path="/contact" element={<LazyPage><ContactPage /></LazyPage>} />
            <Route path="/privacy" element={<LazyPage><PrivacyPage /></LazyPage>} />
            <Route path="/cookies" element={<LazyPage><CookiePolicyPage /></LazyPage>} />
            <Route path="/toc" element={<LazyPage><TermsPage /></LazyPage>} />
            <Route path="/disclaimer" element={<LazyPage><DisclaimerPage /></LazyPage>} />
            <Route path="/legal/data-processing" element={<LazyPage><DataProcessingPolicy /></LazyPage>} />
            <Route path="/legal/activity-insights" element={<LazyPage><UserActivityInsightsNotice /></LazyPage>} />
            <Route path="/legal/data-rights" element={<LazyPage><DataRightsAndGrievance /></LazyPage>} />
          </Route>
          <Route
            path="/balances"
            element={
              <ProtectedRoute allowedRoles={["admin", "cashier"]} blockAccountantCashier>
                <Layout>
                  <LazyPage>
                    <Balances />
                  </LazyPage>
                </Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/dashboard"
            element={
              <ProtectedRoute>
                <Layout>
                  <Dashboard />
                </Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/master"
            element={
              <ProtectedRoute allowedRoles={["master_admin"]}>
                <Layout>
                  <LazyPage>
                    <MasterAdminDashboard />
                  </LazyPage>
                </Layout>
              </ProtectedRoute>
            }
          />
          <Route path="/home" element={<Navigate to="/" replace />} />
          <Route
            path="/expenses"
            element={
              <ProtectedRoute allowedRoles={[...EXPENSE_SUBMITTER_ROLES]} blockAccountantCashier>
                <Layout>
                  <Expenses />
                </Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/expenses/new"
            element={
              <ProtectedRoute allowedRoles={[...EXPENSE_SUBMITTER_ROLES]} blockAccountantCashier>
                <Layout>
                  <ExpenseForm />
                </Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/expenses/batch/new"
            element={
              <ProtectedRoute allowedRoles={[...EXPENSE_SUBMITTER_ROLES]} blockAccountantCashier>
                <Layout>
                  <LazyPage>
                    <ExpenseBatchForm />
                  </LazyPage>
                </Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/expenses/batch/:batchId/review"
            element={
              <ProtectedRoute allowedRoles={["admin", "employee", ...EXPENSE_REVIEW_ROLES]}>
                <Layout>
                  <LazyPage>
                    <BatchExpenseReview />
                  </LazyPage>
                </Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/expenses/:id"
            element={
              <ProtectedRoute
                allowedRoles={[...EXPENSE_SUBMITTER_ROLES, ...EXPENSE_REVIEW_ROLES]}
                allowAccountantCashier
              >
                <Layout>
                  <ExpenseDetail />
                </Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/expenses/:id/edit"
            element={
              <ProtectedRoute allowedRoles={[...EXPENSE_SUBMITTER_ROLES]} blockAccountantCashier>
                <Layout>
                  <ExpenseForm />
                </Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin"
            element={
              <ProtectedRoute allowedRoles={["admin", "cashier"]} blockAccountantCashier>
                <Navigate to="/admin/expenses" replace />
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/expenses"
            element={
              <ProtectedRoute allowedRoles={["admin", "cashier"]} blockAccountantCashier>
                <Layout fullWidth>
                  <LazyPage>
                    <AdminPanel />
                  </LazyPage>
                </Layout>
              </ProtectedRoute>
            }
          />
          {/* Admin submits an expense on behalf of an employee — delegated
              action, admin-only (never accountant-cashier). */}
          <Route
            path="/admin/submit-expense"
            element={
              <ProtectedRoute allowedRoles={["admin"]}>
                <Layout>
                  <LazyPage>
                    <AdminSubmitExpense />
                  </LazyPage>
                </Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/users"
            element={
              <ProtectedRoute allowedRoles={["admin"]}>
                <Layout>
                  <LazyPage>
                    <UserManagement />
                  </LazyPage>
                </Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/user-audit"
            element={
              <ProtectedRoute allowedRoles={["admin"]}>
                <Layout>
                  <LazyPage>
                    <UserAudit />
                  </LazyPage>
                </Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/user-activity"
            element={
              <ProtectedRoute allowedRoles={["admin"]}>
                <Layout>
                  <LazyPage>
                    <UserActivityInsights />
                  </LazyPage>
                </Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/reports"
            element={
              <ProtectedRoute allowedRoles={["admin"]} allowAccountantCashier>
                <Layout>
                  <LazyPage>
                    <Reports />
                  </LazyPage>
                </Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/pwtally"
            element={
              <ProtectedRoute allowedRoles={["admin"]}>
                <Layout>
                  <LazyPage>
                    <PwtFeatureGate>
                      <AdminPwTally />
                    </PwtFeatureGate>
                  </LazyPage>
                </Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/accountant/expenses"
            element={
              <ProtectedRoute allowedRoles={["admin", "cashier"]} allowAccountantCashier>
                <Layout>
                  <LazyPage>
                    <AccountantApprovedExpenses />
                  </LazyPage>
                </Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/categories"
            element={
              <ProtectedRoute allowedRoles={["admin"]}>
                <Layout>
                  <LazyPage>
                    <CategoryManagement />
                  </LazyPage>
                </Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/my-teams"
            element={
              <ProtectedRoute allowedRoles={["admin", "engineer", "team_leader", "executive"]}>
                <Layout>
                  <LazyPage>
                    <MyTeams />
                  </LazyPage>
                </Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/team-reports"
            element={
              <ProtectedRoute allowedRoles={["engineer", "team_leader", "executive"]}>
                <Layout>
                  <LazyPage>
                    <TeamReports />
                  </LazyPage>
                </Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/my-reports"
            element={
              <ProtectedRoute allowedRoles={["employee"]}>
                <Layout>
                  <LazyPage>
                    <MyReports />
                  </LazyPage>
                </Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/settings"
            element={
              <ProtectedRoute allowedRoles={[...STANDARD_APP_ROLES]}>
                <Layout>
                  <LazyPage>
                    <Settings />
                  </LazyPage>
                </Layout>
              </ProtectedRoute>
            }
          />
          {/* DOC-080 — the wrapper picks EngineerReview or the server-backed
              page from a flag. Role access is unchanged. */}
          <Route
            path="/review"
            element={
              <ProtectedRoute allowedRoles={[...EXPENSE_REVIEW_ROLES]}>
                <Layout fullWidth>
                  <LazyPage>
                    <ReviewExpenses />
                  </LazyPage>
                </Layout>
              </ProtectedRoute>
            }
          />
          {/* /debug/review-expenses removed — consolidated into the single
              canonical /review page. Its proven UX is being promoted there. */}
          <Route
            path="/analytics"
            element={
              <ProtectedRoute allowedRoles={["employee", "admin", "cashier"]} blockAccountantCashier>
                <Layout>
                  <LazyPage>
                    <Analytics />
                  </LazyPage>
                </Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/cashier/transactions"
            element={
              <ProtectedRoute allowedRoles={["cashier"]} blockAccountantCashier>
                <Layout>
                  <LazyPage>
                    <CashierTransactions />
                  </LazyPage>
                </Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/cash-transfer-history"
            element={
              <ProtectedRoute allowedRoles={["admin", "cashier"]}>
                <Layout>
                  <LazyPage>
                    <CashTransferHistory />
                  </LazyPage>
                </Layout>
              </ProtectedRoute>
            }
          />
          {/*
            DOC-087 — employee-only balance credit history. The route exists
            unconditionally; the page itself returns to /dashboard when the
            employee_transfer_history organization feature is off, and the RPC
            refuses independently, so neither the route nor the flag alone is
            the security boundary.
          */}
          <Route
            path="/balance-history"
            element={
              <ProtectedRoute allowedRoles={["employee"]}>
                <Layout>
                  <LazyPage>
                    <EmployeeBalanceHistory />
                  </LazyPage>
                </Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/transfer-offers"
            element={
              <ProtectedRoute blockAccountantCashier>
                <Layout>
                  <LazyPage>
                    <TransferOffers />
                  </LazyPage>
                </Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/notifications"
            element={
              <ProtectedRoute allowedRoles={[...STANDARD_APP_ROLES]}>
                <Layout>
                  <Notifications />
                </Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/help"
            element={
              <ProtectedRoute allowedRoles={[...STANDARD_APP_ROLES]}>
                <Layout>
                  <LazyPage>
                    <HelpTutorial />
                  </LazyPage>
                </Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/notification-settings"
            element={
              <ProtectedRoute allowedRoles={[...STANDARD_APP_ROLES]}>
                <Layout>
                  <LazyPage>
                    <NotificationSettings />
                  </LazyPage>
                </Layout>
              </ProtectedRoute>
            }
          />
          {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
          <Route path="*" element={<NotFound />} />
        </Routes>
        </GlobalSystemStatusShell>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
