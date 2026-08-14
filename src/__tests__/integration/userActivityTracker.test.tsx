import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { UserActivityTracker } from '@/components/UserActivityTracker'
import { useAuth } from '@/contexts/AuthContext'
import { supabase } from '@/integrations/supabase/client'

// setup.ts already mocks useAuth and supabase. Here we attach rpc to the
// supabase mock (the global mock only covers auth/from/channel/functions/storage).
const rpcMock = vi.fn().mockResolvedValue({ data: 'session-uuid-123', error: null })

const LEADER_KEY = 'pesowise-user-activity-leader'

const makeAuthBase = (overrides: Partial<ReturnType<typeof useAuth>> = {}) => ({
  user: { id: 'user-abc', email: 'user@test.com' } as ReturnType<typeof useAuth>['user'],
  session: null,
  userRole: 'employee' as const,
  loading: false,
  signOut: vi.fn(),
  organizationId: 'org-xyz',
  organizationFeatureFlags: {},
  hasOrganizationFeature: vi.fn().mockReturnValue(false),
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
  ...overrides,
})

beforeEach(() => {
  // Attach rpc to the already-mocked supabase object
  ;(supabase as unknown as Record<string, unknown>).rpc = rpcMock
  rpcMock.mockResolvedValue({ data: 'session-uuid-123', error: null })
  localStorage.clear()
  vi.clearAllMocks()
  // Re-attach after clearAllMocks clears the mock fn state
  ;(supabase as unknown as Record<string, unknown>).rpc = rpcMock
  rpcMock.mockResolvedValue({ data: 'session-uuid-123', error: null })
})

afterEach(() => {
  localStorage.clear()
})

describe('UserActivityTracker', () => {
  it('does not call start_user_activity_session when feature is disabled', async () => {
    vi.mocked(useAuth).mockReturnValue(
      makeAuthBase({ hasOrganizationFeature: vi.fn().mockReturnValue(false) })
    )

    const { unmount } = render(<UserActivityTracker />)

    // Give the effect time to run
    await new Promise((r) => setTimeout(r, 0))

    expect(rpcMock).not.toHaveBeenCalled()
    unmount()
  })

  it('does not call start_user_activity_session when user is null', async () => {
    vi.mocked(useAuth).mockReturnValue(
      makeAuthBase({
        user: null,
        hasOrganizationFeature: vi.fn().mockReturnValue(true),
      })
    )

    const { unmount } = render(<UserActivityTracker />)
    await new Promise((r) => setTimeout(r, 0))

    expect(rpcMock).not.toHaveBeenCalled()
    unmount()
  })

  it('does not call start_user_activity_session when noticeAcknowledged is false (default)', async () => {
    vi.mocked(useAuth).mockReturnValue(
      makeAuthBase({ hasOrganizationFeature: vi.fn().mockReturnValue(true) })
    )

    // noticeAcknowledged defaults to false → tracker must not start
    const { unmount } = render(<UserActivityTracker />)
    await new Promise((r) => setTimeout(r, 0))

    expect(rpcMock).not.toHaveBeenCalled()
    unmount()
  })

  it('calls start_user_activity_session when feature is enabled, user is set, and noticeAcknowledged is true', async () => {
    vi.mocked(useAuth).mockReturnValue(
      makeAuthBase({ hasOrganizationFeature: vi.fn().mockReturnValue(true) })
    )

    const { unmount } = render(<UserActivityTracker noticeAcknowledged={true} />)

    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith('start_user_activity_session', expect.objectContaining({
        p_user_agent: expect.any(String),
      }))
    })

    unmount()
  })

  it('clears the leader key on unmount even when start_user_activity_session returns null', async () => {
    rpcMock.mockResolvedValue({ data: null, error: null }) // simulate feature off server-side

    vi.mocked(useAuth).mockReturnValue(
      makeAuthBase({ hasOrganizationFeature: vi.fn().mockReturnValue(true) })
    )

    const { unmount } = render(<UserActivityTracker noticeAcknowledged={true} />)

    // Wait for start RPC attempt
    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith('start_user_activity_session', expect.anything())
    })

    unmount()

    // After unmount cleanup runs: leader key must be cleared regardless of null session
    expect(localStorage.getItem(LEADER_KEY)).toBeNull()
  })

  it('does not start session when organizationId is null', async () => {
    vi.mocked(useAuth).mockReturnValue(
      makeAuthBase({
        organizationId: null,
        hasOrganizationFeature: vi.fn().mockReturnValue(true),
      })
    )

    const { unmount } = render(<UserActivityTracker />)
    await new Promise((r) => setTimeout(r, 0))

    expect(rpcMock).not.toHaveBeenCalled()
    unmount()
  })

  it('does not start session for master_admin role', async () => {
    vi.mocked(useAuth).mockReturnValue(
      makeAuthBase({
        userRole: 'master_admin',
        hasOrganizationFeature: vi.fn().mockReturnValue(true),
      })
    )

    const { unmount } = render(<UserActivityTracker />)
    await new Promise((r) => setTimeout(r, 0))

    expect(rpcMock).not.toHaveBeenCalled()
    unmount()
  })

  it('renders null (no DOM output)', () => {
    vi.mocked(useAuth).mockReturnValue(makeAuthBase())
    const { container } = render(<UserActivityTracker />)
    expect(container.firstChild).toBeNull()
  })
})
