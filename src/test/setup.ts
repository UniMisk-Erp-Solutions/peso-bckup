import '@testing-library/jest-dom'
import { vi } from 'vitest'
import enAdmin from '@/locales/en/admin.json'
import enCommon from '@/locales/en/common.json'
import enExpenses from '@/locales/en/expenses.json'
import enAuth from '@/locales/en/auth.json'
import enNav from '@/locales/en/nav.json'
import enValidation from '@/locales/en/validation.json'
import enSettings from '@/locales/en/settings.json'
import enBalances from '@/locales/en/balances.json'
import enNotifications from '@/locales/en/notifications.json'
import enReports from '@/locales/en/reports.json'
import enTransfers from '@/locales/en/transfers.json'
import enCashier from '@/locales/en/cashier.json'
import enHelp from '@/locales/en/help.json'
import enAnalytics from '@/locales/en/analytics.json'
import enMaster from '@/locales/en/master.json'

const T_NAMESPACES: Record<string, unknown> = {
  admin: enAdmin,
  common: enCommon,
  expenses: enExpenses,
  auth: enAuth,
  nav: enNav,
  validation: enValidation,
  settings: enSettings,
  balances: enBalances,
  notifications: enNotifications,
  reports: enReports,
  transfers: enTransfers,
  cashier: enCashier,
  help: enHelp,
  analytics: enAnalytics,
  master: enMaster,
}

function resolveTranslation(key: string, opts?: Record<string, unknown>): string {
  const colonIdx = key.indexOf(':')
  const [ns, restKey] = colonIdx >= 0
    ? [key.slice(0, colonIdx), key.slice(colonIdx + 1)]
    : ['expenses', key]

  const nsData = T_NAMESPACES[ns]
  if (!nsData) {
    return opts?.defaultValue !== undefined ? String(opts.defaultValue) : key
  }

  const parts = restKey.split('.')
  let val: unknown = nsData
  for (const part of parts) {
    if (val == null || typeof val !== 'object') {
      return opts?.defaultValue !== undefined ? String(opts.defaultValue) : key
    }
    val = (val as Record<string, unknown>)[part]
  }

  if (typeof val === 'string') {
    if (opts) {
      return val.replace(/\{\{(\w+)\}\}/g, (_, k) => String(opts[k] ?? `{{${k}}}`))
    }
    return val
  }
  return opts?.defaultValue !== undefined ? String(opts.defaultValue) : key
}

// Mock Supabase client
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(),
      onAuthStateChange: vi.fn(),
      signOut: vi.fn(),
      admin: {
        createUser: vi.fn(),
      },
    },
    from: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      insert: vi.fn().mockReturnThis(),
      update: vi.fn().mockReturnThis(),
      delete: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      single: vi.fn(),
      maybeSingle: vi.fn(),
    })),
    channel: vi.fn().mockReturnValue({
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn(),
    }),
    removeChannel: vi.fn(),
    functions: {
      invoke: vi.fn().mockResolvedValue({ data: null, error: null }),
    },
    storage: {
      from: vi.fn(() => ({
        upload: vi.fn(),
        remove: vi.fn(),
        getPublicUrl: vi.fn(),
      })),
    },
  },
}))

// Mock React Router — spread actual module so named exports like BrowserRouter survive
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>()
  return {
    ...actual,
    useNavigate: () => vi.fn(),
    useParams: () => ({}),
    Navigate: ({ to }: { to: string }) => `Navigate to ${to}`,
  }
})

// Mock date-fns
vi.mock('date-fns', () => ({
  format: vi.fn((date: Date, format: string) => '2024-01-01'),
}))

// Mock toast
vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({
    toast: vi.fn(),
  }),
}))

// Mock i18n — resolve keys against actual locale JSON files so text assertions match
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: resolveTranslation,
    i18n: { language: 'en', changeLanguage: vi.fn() },
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  I18nextProvider: ({ children }: { children: React.ReactNode }) => children,
  Trans: ({ i18nKey }: { i18nKey: string }) => i18nKey,
}))

// Mock AuthContext — use vi.fn() so individual tests can override with mockReturnValue
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: vi.fn().mockReturnValue({
    user: { id: 'test-user-id', email: 'test@example.com' },
    session: null,
    userRole: 'employee',
    userProfile: null,
    organization: null,
    organizationId: null,
    loading: false,
    signOut: vi.fn(),
    refreshUserProfile: vi.fn(),
    refreshOrganization: vi.fn(),
    appBaseDomain: 'localhost',
    isTenantHost: false,
    tenantSubdomainLabel: null,
    tenantHostOrgId: null,
    tenantHostOrg: null,
    organizationFeatureFlags: {},
    hasOrganizationFeature: vi.fn().mockReturnValue(false),
    tenantEmployeeIdLoginEnabled: false,
    tenantResolutionStatus: 'idle',
    tenantFeatureStatus: 'idle',
    retryTenantResolution: vi.fn(),
    preferredLanguage: 'en',
    setPreferredLanguage: vi.fn(),
    isAccountantCashier: false,
    userBalance: null,
    refreshBalance: vi.fn(),
  }),
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
}))

// Global test utilities
global.ResizeObserver = vi.fn().mockImplementation(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
}))

// Mock window.matchMedia
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation(query => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
})
