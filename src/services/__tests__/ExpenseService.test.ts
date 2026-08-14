/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ExpenseService, CreateExpenseData } from '@/services/ExpenseService'
import { supabase } from '@/integrations/supabase/client'

// Mock Supabase — include rpc so verifyExpense can reach fetchExpenseReviewHead
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: vi.fn(() => ({
      insert: vi.fn().mockReturnThis(),
      update: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      delete: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ data: [], error: null }),
      in: vi.fn().mockResolvedValue({ data: [], error: null }),
      single: vi.fn(),
      maybeSingle: vi.fn(),
    })),
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
  },
}))

describe('ExpenseService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('createExpense', () => {
    it('should create expense and return it with empty line items', async () => {
      const mockExpense = {
        id: 'expense-1',
        user_id: 'user-1',
        title: 'Test Trip',
        destination: 'New York',
        trip_start: '2024-01-01',
        trip_end: '2024-01-03',
        purpose: 'Business meeting',
        total_amount: 500.00,
        status: 'draft',
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      }

      const mockFrom = vi.mocked(supabase.from)
      const mockMaybeSingle = vi.fn()
        .mockResolvedValueOnce({ data: { organization_id: 'org-1' }, error: null }) // getUserOrganizationId
        .mockResolvedValueOnce({ data: mockExpense, error: null }) // expense insert

      mockFrom.mockReturnValue({
        insert: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue({ data: [], error: null }),
        in: vi.fn().mockResolvedValue({ data: [], error: null }),
        maybeSingle: mockMaybeSingle,
        single: vi.fn(),
      } as any)

      const expenseData: CreateExpenseData = {
        title: 'Test Trip',
        destination: 'New York',
        trip_start: '2024-01-01',
        trip_end: '2024-01-03',
        purpose: 'Business meeting',
        line_items: [],
      }

      const result = await ExpenseService.createExpense('user-1', expenseData)

      expect(result).toEqual({ ...mockExpense, expense_line_items: [] })
      expect(result.total_amount).toBe(500.00)
    })

    it('should throw error when user has no organization', async () => {
      const mockFrom = vi.mocked(supabase.from)
      mockFrom.mockReturnValue({
        select: vi.fn().mockReturnThis(),
        insert: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
      } as any)

      const expenseData: CreateExpenseData = {
        title: 'Test Trip',
        destination: 'New York',
        trip_start: '2024-01-01',
        trip_end: '2024-01-03',
        line_items: [],
      }

      await expect(ExpenseService.createExpense('user-1', expenseData))
        .rejects.toThrow('User is not associated with an organization')
    })

    it('should throw error when user has no organization (zero amount case)', async () => {
      const mockFrom = vi.mocked(supabase.from)
      mockFrom.mockReturnValue({
        select: vi.fn().mockReturnThis(),
        insert: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
      } as any)

      const expenseData: CreateExpenseData = {
        title: 'Test Trip',
        destination: 'New York',
        trip_start: '2024-01-01',
        trip_end: '2024-01-03',
        line_items: [],
      }

      await expect(ExpenseService.createExpense('user-1', expenseData))
        .rejects.toThrow('User is not associated with an organization')
    })
  })

  describe('submitExpense', () => {
    it('should submit expense and change status', async () => {
      // expense.total_amount must be <= 50 (default attachment limit) to skip the attachment check
      const mockDraftExpense = {
        id: 'expense-1',
        user_id: 'user-1',
        status: 'draft',
        total_amount: 30.00,
        organization_id: 'org-1',
        title: 'Test',
      }

      const mockFrom = vi.mocked(supabase.from)
      const mockMaybeSingle = vi.fn()
        .mockResolvedValueOnce({ data: mockDraftExpense, error: null })    // expense fetch
        .mockResolvedValueOnce({ data: null, error: null })                // hasOrgRole admin
        .mockResolvedValueOnce({ data: null, error: null })                // hasOrgRole engineer
        .mockResolvedValueOnce({ data: null, error: null })                // fetchMembershipRole
        .mockResolvedValueOnce({ data: null, error: null })                // isOrganizationFeatureEnabled
        .mockResolvedValueOnce({ data: { id: 'expense-1', status: 'submitted' }, error: null }) // update

      mockFrom.mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        update: vi.fn().mockReturnThis(),
        insert: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue({ data: [], error: null }),
        in: vi.fn().mockResolvedValue({ data: [], error: null }),
        maybeSingle: mockMaybeSingle,
        single: vi.fn(),
      } as any)

      const result = await ExpenseService.submitExpense('expense-1', 'user-1')

      expect(result.status).toBe('submitted')
    })

    it('should throw error when expense is not found', async () => {
      const mockFrom = vi.mocked(supabase.from)
      mockFrom.mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
      } as any)

      await expect(ExpenseService.submitExpense('expense-1', 'user-1'))
        .rejects.toThrow('Expense not found or you don\'t have access')
    })
  })

  describe('approveExpense', () => {
    it('should throw when approver has no organization', async () => {
      const mockFrom = vi.mocked(supabase.from)
      mockFrom.mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
      } as any)

      await expect(ExpenseService.approveExpense('expense-1', 'user-1', 'Approved'))
        .rejects.toThrow('Approver is not associated with an organization')
    })

    it('should throw error if user has no approval role', async () => {
      const mockFrom = vi.mocked(supabase.from)
      const mockMaybeSingle = vi.fn()
        .mockResolvedValueOnce({ data: { organization_id: 'org-1' }, error: null }) // getUserOrganizationId
        .mockResolvedValueOnce({ data: null, error: null }) // hasOrgRole admin
        .mockResolvedValueOnce({ data: null, error: null }) // hasOrgRole engineer
        .mockResolvedValueOnce({ data: null, error: null }) // hasOrgRole team_leader
        .mockResolvedValueOnce({ data: null, error: null }) // hasOrgRole executive

      mockFrom.mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        in: vi.fn().mockResolvedValue({ data: [], error: null }),
        maybeSingle: mockMaybeSingle,
      } as any)

      await expect(ExpenseService.approveExpense('expense-1', 'user-1', 'Approved'))
        .rejects.toThrow('Only managers or administrators can approve expenses')
    })
  })

  describe('rejectExpense', () => {
    it('should throw when rejector has no organization', async () => {
      const mockFrom = vi.mocked(supabase.from)
      mockFrom.mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
      } as any)

      await expect(ExpenseService.rejectExpense('expense-1', 'admin-1', 'Missing receipts'))
        .rejects.toThrow('Rejector is not associated with an organization')
    })
  })

  describe('verifyExpense', () => {
    it('should throw when reviewer has no organization', async () => {
      const mockFrom = vi.mocked(supabase.from)
      mockFrom.mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
      } as any)

      await expect(ExpenseService.verifyExpense('expense-1', 'engineer-1', 'Verified'))
        .rejects.toThrow('Reviewer is not associated with an organization')
    })

    it('should throw error when expense is not found for reviewer', async () => {
      const mockFrom = vi.mocked(supabase.from)
      const mockMaybeSingle = vi.fn()
        .mockResolvedValueOnce({ data: { organization_id: 'org-1' }, error: null }) // getUserOrganizationId
        .mockResolvedValueOnce({ data: null, error: null })                          // fetchMembershipRole → null (not team_leader)
        .mockResolvedValueOnce({ data: null, error: null })                          // isOrganizationFeatureEnabled (teams_enabled) inside loadHierarchyContext
        .mockResolvedValueOnce({ data: null, error: null })                          // fetchExpenseReviewHead fallback fetch → null → "not found"

      mockFrom.mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue({ data: [], error: null }),
        in: vi.fn().mockResolvedValue({ data: [], error: null }),
        maybeSingle: mockMaybeSingle,
      } as any)

      // supabase.rpc returns null → fetchExpenseReviewHead falls back to direct fetch → null → "not found"
      vi.mocked(supabase.rpc).mockResolvedValue({ data: null, error: null } as any)

      await expect(ExpenseService.verifyExpense('expense-1', 'engineer-1', 'Verified'))
        .rejects.toThrow('Expense not found or you don\'t have access')
    })
  })

  describe('submitExpenseBatch', () => {
    it('throws when batch expense entry is disabled for the organization', async () => {
      const mockFrom = vi.mocked(supabase.from)
      mockFrom.mockImplementation((table: string) => {
        if (table === 'organization_memberships') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: { organization_id: 'org-1' },
              error: null,
            }),
          } as any
        }
        if (table === 'organization_features') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: { enabled: false },
              error: null,
            }),
          } as any
        }
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        } as any
      })

      await expect(
        ExpenseService.submitExpenseBatch('user-1', {
          shared: {
            expenseDate: new Date('2024-06-01'),
            sharedDestination: 'Mumbai',
          },
          lines: [
            { title: 'Taxi', amount: 100, category: 'travel', destination: 'Mumbai' },
            { title: 'Meal', amount: 50, category: 'food', destination: 'Mumbai' },
          ],
          formFieldValues: {},
          attachmentMode: 'per_line',
          metaByFilename: {},
        }),
      ).rejects.toThrow(/not enabled/i)
    })
  })
})
