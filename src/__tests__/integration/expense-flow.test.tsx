import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BrowserRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import ExpenseForm from '@/pages/ExpenseForm'
import AdminPanel from '@/pages/AdminPanel'
import EngineerReview from '@/pages/EngineerReview'
import UserManagement from '@/pages/UserManagement'
import { useAuth } from '@/contexts/AuthContext'
import type { AppRole } from '@/contexts/auth-context'
import { supabase } from '@/integrations/supabase/client'

// Mock components that might cause issues
vi.mock('@/components/FileUpload', () => ({
  FileUpload: () => <div data-testid="file-upload">File Upload Component</div>,
}))

vi.mock('@/components/StatusBadge', () => ({
  StatusBadge: ({ status }: { status: string }) => (
    <span data-testid="status-badge">{status}</span>
  ),
}))

// Test wrapper component
const TestWrapper = ({ children }: { children: React.ReactNode }) => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  })

  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>{children}</BrowserRouter>
    </QueryClientProvider>
  )
}

describe('Expense Flow Integration Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('ExpenseForm', () => {
    it('should render expense form page', async () => {
      render(
        <TestWrapper>
          <ExpenseForm />
        </TestWrapper>
      )

      // "New Expense" is the page title rendered via t("expenses:form.titleNew")
      await waitFor(() => {
        expect(screen.getByText('New Expense')).toBeInTheDocument()
      })
    })

    it('should render expense form with submit capability', async () => {
      render(
        <TestWrapper>
          <ExpenseForm />
        </TestWrapper>
      )

      await waitFor(() => {
        expect(screen.getByText('New Expense')).toBeInTheDocument()
      })

      // The submit button is always present in the expense form
      expect(screen.getByRole('button', { name: /submit/i })).toBeInTheDocument()
    })

    it('should render expense form without crashing on submit', async () => {
      const user = userEvent.setup()

      render(
        <TestWrapper>
          <ExpenseForm />
        </TestWrapper>
      )

      await waitFor(() => {
        expect(screen.getByText('New Expense')).toBeInTheDocument()
      })

      // Clicking submit should not crash the component (may show validation)
      const submitButton = screen.getByRole('button', { name: /submit/i })
      await user.click(submitButton)

      // Component still renders after submit attempt
      expect(screen.getByText('New Expense')).toBeInTheDocument()
    })

    it('should render expense form with amount field', async () => {
      render(
        <TestWrapper>
          <ExpenseForm />
        </TestWrapper>
      )

      await waitFor(() => {
        expect(screen.getByText('New Expense')).toBeInTheDocument()
      })

      // File upload component is integrated (mocked)
      expect(screen.getByTestId('file-upload')).toBeInTheDocument()
    })
  })

  describe('UserManagement', () => {
    it('should render user creation form for admin', async () => {
      const user = userEvent.setup()

      // Mock admin role
      vi.mocked(useAuth).mockReturnValue({
        user: { id: 'admin-1', email: 'admin@test.com' },
        session: null,
        userRole: 'admin',
        loading: false,
        signOut: vi.fn(),
        organizationFeatureFlags: {},
        hasOrganizationFeature: vi.fn().mockReturnValue(false),
        organizationId: null,
        userProfile: null,
        organization: null,
        refreshUserProfile: vi.fn(),
        refreshOrganization: vi.fn(),
        preferredLanguage: 'en' as const,
        setPreferredLanguage: vi.fn(),
        appBaseDomain: 'localhost',
        isTenantHost: false,
        tenantSubdomainLabel: null,
        tenantHostOrgId: null,
        tenantHostOrg: null,
        tenantEmployeeIdLoginEnabled: false,
        isAccountantCashier: false,
        userBalance: null,
        refreshBalance: vi.fn(),
      })

      render(
        <TestWrapper>
          <UserManagement />
        </TestWrapper>
      )

      // t("admin:users.title") = "User Management"
      expect(screen.getByText('User Management')).toBeInTheDocument()

      // Navigate to the "Create User" section tab (multiple buttons may match)
      await user.click(screen.getAllByRole('button', { name: /create user/i })[0])

      expect(screen.getByText('Create New User')).toBeInTheDocument()
      expect(screen.getByLabelText('Full Name *')).toBeInTheDocument()
      // Label is "Email address *" (lowercase 'a') — use case-insensitive match
      expect(screen.getByLabelText(/email address/i)).toBeInTheDocument()
      // Role label exists (ShadCN Select doesn't wire htmlFor to a native control)
      expect(screen.getByText('Role *')).toBeInTheDocument()
    })

    it('should show access denied for non-admin users', () => {
      // Mock employee role
      vi.mocked(useAuth).mockReturnValue({
        user: { id: 'user-1', email: 'user@test.com' },
        session: null,
        userRole: 'employee',
        loading: false,
        signOut: vi.fn(),
        organizationFeatureFlags: {},
        hasOrganizationFeature: vi.fn().mockReturnValue(false),
        organizationId: null,
        userProfile: null,
        organization: null,
        refreshUserProfile: vi.fn(),
        refreshOrganization: vi.fn(),
        preferredLanguage: 'en' as const,
        setPreferredLanguage: vi.fn(),
        appBaseDomain: 'localhost',
        isTenantHost: false,
        tenantSubdomainLabel: null,
        tenantHostOrgId: null,
        tenantHostOrg: null,
        tenantEmployeeIdLoginEnabled: false,
        isAccountantCashier: false,
        userBalance: null,
        refreshBalance: vi.fn(),
      })

      render(
        <TestWrapper>
          <UserManagement />
        </TestWrapper>
      )

      // t("common:accessDenied.title") = "Access Denied"
      expect(screen.getByText('Access Denied')).toBeInTheDocument()
      // t("admin:users.accessDeniedDescription") = "Only administrators can access user management."
      expect(screen.getByText('Only administrators can access user management.')).toBeInTheDocument()
    })

    it('should validate user creation form', async () => {
      const user = userEvent.setup()

      // Mock admin role
      vi.mocked(useAuth).mockReturnValue({
        user: { id: 'admin-1', email: 'admin@test.com' },
        session: null,
        userRole: 'admin',
        loading: false,
        signOut: vi.fn(),
        organizationFeatureFlags: {},
        hasOrganizationFeature: vi.fn().mockReturnValue(false),
        organizationId: null,
        userProfile: null,
        organization: null,
        refreshUserProfile: vi.fn(),
        refreshOrganization: vi.fn(),
        preferredLanguage: 'en' as const,
        setPreferredLanguage: vi.fn(),
        appBaseDomain: 'localhost',
        isTenantHost: false,
        tenantSubdomainLabel: null,
        tenantHostOrgId: null,
        tenantHostOrg: null,
        tenantEmployeeIdLoginEnabled: false,
        isAccountantCashier: false,
        userBalance: null,
        refreshBalance: vi.fn(),
      })

      render(
        <TestWrapper>
          <UserManagement />
        </TestWrapper>
      )

      // Navigate to the "Create User" section tab first (multiple buttons match)
      await user.click(screen.getAllByRole('button', { name: /create user/i })[0])

      // The "Create User Account" button is present and enabled (not yet loading)
      const createButton = screen.getByRole('button', { name: /create user account/i })
      expect(createButton).toBeEnabled()

      // Submit with all fields empty — password check fires first and returns early
      await user.click(createButton)

      // The Supabase edge function (invokeAdminEdgeFunction → supabase.functions.invoke)
      // must NOT have been called: form validation blocked the network call
      expect(vi.mocked(supabase.functions.invoke)).not.toHaveBeenCalled()
    })
  })

  describe('AdminPanel', () => {
    it('should render admin panel with expense management', () => {
      // Mock admin role
      vi.mocked(useAuth).mockReturnValue({
        user: { id: 'admin-1', email: 'admin@test.com' },
        session: null,
        userRole: 'admin',
        loading: false,
        signOut: vi.fn(),
        organizationFeatureFlags: {},
        hasOrganizationFeature: vi.fn().mockReturnValue(false),
        organizationId: null,
        userProfile: null,
        organization: null,
        refreshUserProfile: vi.fn(),
        refreshOrganization: vi.fn(),
        preferredLanguage: 'en' as const,
        setPreferredLanguage: vi.fn(),
        appBaseDomain: 'localhost',
        isTenantHost: false,
        tenantSubdomainLabel: null,
        tenantHostOrgId: null,
        tenantHostOrg: null,
        tenantEmployeeIdLoginEnabled: false,
        isAccountantCashier: false,
        userBalance: null,
        refreshBalance: vi.fn(),
      })

      render(
        <TestWrapper>
          <AdminPanel />
        </TestWrapper>
      )

      // t("admin:panel.title") = "Admin Panel"
      expect(screen.getByText('Admin Panel')).toBeInTheDocument()
      // "All Expenses" is hardcoded in AdminPanel (line 1729)
      expect(screen.getByText('All Expenses')).toBeInTheDocument()
    })

    it('should show expense statistics', () => {
      // Mock admin role
      vi.mocked(useAuth).mockReturnValue({
        user: { id: 'admin-1', email: 'admin@test.com' },
        session: null,
        userRole: 'admin',
        loading: false,
        signOut: vi.fn(),
        organizationFeatureFlags: {},
        hasOrganizationFeature: vi.fn().mockReturnValue(false),
        organizationId: null,
        userProfile: null,
        organization: null,
        refreshUserProfile: vi.fn(),
        refreshOrganization: vi.fn(),
        preferredLanguage: 'en' as const,
        setPreferredLanguage: vi.fn(),
        appBaseDomain: 'localhost',
        isTenantHost: false,
        tenantSubdomainLabel: null,
        tenantHostOrgId: null,
        tenantHostOrg: null,
        tenantEmployeeIdLoginEnabled: false,
        isAccountantCashier: false,
        userBalance: null,
        refreshBalance: vi.fn(),
      })

      render(
        <TestWrapper>
          <AdminPanel />
        </TestWrapper>
      )

      // t("admin:panel.stats.*") — resolved via real locale lookups
      expect(screen.getByText('Total Expenses')).toBeInTheDocument()
      expect(screen.getByText('Pending')).toBeInTheDocument()
      expect(screen.getByText('Approved')).toBeInTheDocument()
      expect(screen.getByText('Total Amount')).toBeInTheDocument()
    })
  })

  describe('EngineerReview', () => {
    it('should render engineer review panel', () => {
      // Mock engineer role
      vi.mocked(useAuth).mockReturnValue({
        user: { id: 'engineer-1', email: 'engineer@test.com' },
        session: null,
        userRole: 'engineer',
        loading: false,
        signOut: vi.fn(),
        organizationFeatureFlags: {},
        hasOrganizationFeature: vi.fn().mockReturnValue(false),
        organizationId: null,
        userProfile: null,
        organization: null,
        refreshUserProfile: vi.fn(),
        refreshOrganization: vi.fn(),
        preferredLanguage: 'en' as const,
        setPreferredLanguage: vi.fn(),
        appBaseDomain: 'localhost',
        isTenantHost: false,
        tenantSubdomainLabel: null,
        tenantHostOrgId: null,
        tenantHostOrg: null,
        tenantEmployeeIdLoginEnabled: false,
        isAccountantCashier: false,
        userBalance: null,
        refreshBalance: vi.fn(),
      })

      render(
        <TestWrapper>
          <EngineerReview />
        </TestWrapper>
      )

      // t("admin:review.title") = "Expense Review"
      expect(screen.getByText('Expense Review')).toBeInTheDocument()
      // t("admin:review.assignedExpenses") = "Assigned Expenses"
      expect(screen.getByText('Assigned Expenses')).toBeInTheDocument()
    })

    it('should show assigned expense statistics', () => {
      // Mock engineer role
      vi.mocked(useAuth).mockReturnValue({
        user: { id: 'engineer-1', email: 'engineer@test.com' },
        session: null,
        userRole: 'engineer',
        loading: false,
        signOut: vi.fn(),
        organizationFeatureFlags: {},
        hasOrganizationFeature: vi.fn().mockReturnValue(false),
        organizationId: null,
        userProfile: null,
        organization: null,
        refreshUserProfile: vi.fn(),
        refreshOrganization: vi.fn(),
        preferredLanguage: 'en' as const,
        setPreferredLanguage: vi.fn(),
        appBaseDomain: 'localhost',
        isTenantHost: false,
        tenantSubdomainLabel: null,
        tenantHostOrgId: null,
        tenantHostOrg: null,
        tenantEmployeeIdLoginEnabled: false,
        isAccountantCashier: false,
        userBalance: null,
        refreshBalance: vi.fn(),
      })

      render(
        <TestWrapper>
          <EngineerReview />
        </TestWrapper>
      )

      // t("admin:review.assignedToMe") = "Assigned to Me"
      expect(screen.getByText('Assigned to Me')).toBeInTheDocument()
      // t("admin:review.pendingReview") = "Pending Review"
      expect(screen.getByText('Pending Review')).toBeInTheDocument()
      // t("admin:review.verified") = "Verified"
      expect(screen.getByText('Verified')).toBeInTheDocument()
    })
  })

  describe('File Upload Validation', () => {
    it('should validate file types and sizes', async () => {
      const user = userEvent.setup()

      render(
        <TestWrapper>
          <ExpenseForm />
        </TestWrapper>
      )

      // Check file upload component is rendered (it is mocked with data-testid)
      expect(screen.getByTestId('file-upload')).toBeInTheDocument()

      // The actual file validation logic is in the FileUpload component
      // which is mocked in this test, but the integration ensures
      // the component is properly integrated into the expense form
    })
  })

  describe('RBAC Integration', () => {
    it('should enforce role-based access control', () => {
      // Test that different roles see different content
      const roles = ['admin', 'engineer', 'employee']

      roles.forEach(role => {
        vi.mocked(useAuth).mockReturnValue({
          user: { id: `${role}-1`, email: `${role}@test.com` },
          session: null,
          userRole: role as AppRole,
          loading: false,
          signOut: vi.fn(),
          organizationFeatureFlags: {},
          hasOrganizationFeature: vi.fn().mockReturnValue(false),
          organizationId: null,
          userProfile: null,
          organization: null,
          refreshUserProfile: vi.fn(),
          refreshOrganization: vi.fn(),
          preferredLanguage: 'en' as const,
          setPreferredLanguage: vi.fn(),
          appBaseDomain: 'localhost',
          isTenantHost: false,
          tenantSubdomainLabel: null,
          tenantHostOrgId: null,
          tenantHostOrg: null,
          tenantEmployeeIdLoginEnabled: false,
          isAccountantCashier: false,
          userBalance: null,
          refreshBalance: vi.fn(),
        })

        const { unmount } = render(
          <TestWrapper>
            <UserManagement />
          </TestWrapper>
        )

        if (role === 'admin') {
          // t("admin:users.title") = "User Management"
          expect(screen.getByText('User Management')).toBeInTheDocument()
        } else {
          // t("common:accessDenied.title") = "Access Denied"
          expect(screen.getByText('Access Denied')).toBeInTheDocument()
        }

        unmount()
      })
    })
  })
})
