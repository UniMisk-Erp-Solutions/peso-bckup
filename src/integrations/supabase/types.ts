export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "13.0.5"
  }
  public: {
    Tables: {
      expense_balance_deductions: {
        Row: {
          id: string
          organization_id: string
          expense_id: string
          employee_user_id: string
          approved_by: string
          expense_amount: number
          balance_before: number
          balance_after: number
          source: string
          created_at: string
        }
        Insert: {
          id?: string
          organization_id: string
          expense_id: string
          employee_user_id: string
          approved_by: string
          expense_amount: number
          balance_before: number
          balance_after: number
          source?: string
          created_at?: string
        }
        Update: {
          id?: string
          organization_id?: string
          expense_id?: string
          employee_user_id?: string
          approved_by?: string
          expense_amount?: number
          balance_before?: number
          balance_after?: number
          source?: string
          created_at?: string
        }
        Relationships: []
      }
      attachments: {
        Row: {
          content_type: string
          created_at: string | null
          expense_id: string
          file_size: number | null
          file_url: string
          filename: string
          id: string
          line_item_id: string | null
          organization_id: string | null
          storage_path: string | null
          uploaded_by: string
        }
        Insert: {
          content_type: string
          created_at?: string | null
          expense_id: string
          file_size?: number | null
          file_url: string
          filename: string
          id?: string
          line_item_id?: string | null
          organization_id?: string | null
          storage_path?: string | null
          uploaded_by: string
        }
        Update: {
          content_type?: string
          created_at?: string | null
          expense_id?: string
          file_size?: number | null
          file_url?: string
          filename?: string
          id?: string
          line_item_id?: string | null
          organization_id?: string | null
          storage_path?: string | null
          uploaded_by?: string
        }
        Relationships: [
          {
            foreignKeyName: "attachments_expense_id_fkey"
            columns: ["expense_id"]
            isOneToOne: false
            referencedRelation: "expenses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attachments_line_item_id_fkey"
            columns: ["line_item_id"]
            isOneToOne: false
            referencedRelation: "expense_line_items"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_logs: {
        Row: {
          action: string
          comment: string | null
          created_at: string | null
          expense_id: string
          id: string
          user_id: string
        }
        Insert: {
          action: string
          comment?: string | null
          created_at?: string | null
          expense_id: string
          id?: string
          user_id: string
        }
        Update: {
          action?: string
          comment?: string | null
          created_at?: string | null
          expense_id?: string
          id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "audit_logs_expense_id_fkey"
            columns: ["expense_id"]
            isOneToOne: false
            referencedRelation: "expenses"
            referencedColumns: ["id"]
          },
        ]
      }
      expense_batches: {
        Row: {
          id: string
          organization_id: string
          user_id: string
          label: string | null
          shared_category: string
          shared_expense_date: string
          line_count: number
          total_amount: number
          created_at: string
        }
        Insert: {
          id?: string
          organization_id: string
          user_id: string
          label?: string | null
          shared_category: string
          shared_expense_date: string
          line_count?: number
          total_amount?: number
          created_at?: string
        }
        Update: {
          id?: string
          organization_id?: string
          user_id?: string
          label?: string | null
          shared_category?: string
          shared_expense_date?: string
          line_count?: number
          total_amount?: number
          created_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "expense_batches_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      expense_correction_logs: {
        Row: {
          id: string
          expense_id: string
          organization_id: string
          edited_by: string
          reason: string | null
          before_json: Json
          after_json: Json
          created_at: string
        }
        Insert: {
          id?: string
          expense_id: string
          organization_id: string
          edited_by: string
          reason?: string | null
          before_json: Json
          after_json: Json
          created_at?: string
        }
        Update: {
          id?: string
          expense_id?: string
          organization_id?: string
          edited_by?: string
          reason?: string | null
          before_json?: Json
          after_json?: Json
          created_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "expense_correction_logs_expense_id_fkey"
            columns: ["expense_id"]
            isOneToOne: false
            referencedRelation: "expenses"
            referencedColumns: ["id"]
          },
        ]
      }
      expense_line_items: {
        Row: {
          amount: number
          category: Database["public"]["Enums"]["expense_category"]
          created_at: string | null
          date: string
          description: string | null
          expense_id: string
          id: string
        }
        Insert: {
          amount: number
          category: Database["public"]["Enums"]["expense_category"]
          created_at?: string | null
          date: string
          description?: string | null
          expense_id: string
          id?: string
        }
        Update: {
          amount?: number
          category?: Database["public"]["Enums"]["expense_category"]
          created_at?: string | null
          date?: string
          description?: string | null
          expense_id?: string
          id?: string
        }
        Relationships: [
          {
            foreignKeyName: "expense_line_items_expense_id_fkey"
            columns: ["expense_id"]
            isOneToOne: false
            referencedRelation: "expenses"
            referencedColumns: ["id"]
          },
        ]
      }
      expenses: {
        Row: {
          admin_comment: string | null
          approval_tier: string | null
          assigned_engineer_id: string | null
          assigned_reviewer_id: string | null
          batch_id: string | null
          created_at: string | null
          destination: string
          id: string
          organization_id: string | null
          purpose: string | null
          status: Database["public"]["Enums"]["expense_status"]
          title: string
          total_amount: number | null
          transaction_number: string | null
          trip_end: string
          trip_start: string
          updated_at: string | null
          user_id: string
          category: string | null
        }
        Insert: {
          admin_comment?: string | null
          approval_tier?: string | null
          assigned_engineer_id?: string | null
          assigned_reviewer_id?: string | null
          batch_id?: string | null
          created_at?: string | null
          destination: string
          id?: string
          organization_id?: string | null
          purpose?: string | null
          status?: Database["public"]["Enums"]["expense_status"]
          title: string
          total_amount?: number | null
          transaction_number?: string | null
          trip_end: string
          trip_start: string
          updated_at?: string | null
          user_id: string
          category?: string | null
        }
        Update: {
          admin_comment?: string | null
          approval_tier?: string | null
          assigned_engineer_id?: string | null
          assigned_reviewer_id?: string | null
          batch_id?: string | null
          created_at?: string | null
          destination?: string
          id?: string
          organization_id?: string | null
          purpose?: string | null
          status?: Database["public"]["Enums"]["expense_status"]
          title?: string
          total_amount?: number | null
          transaction_number?: string | null
          trip_end?: string
          trip_start?: string
          updated_at?: string | null
          user_id?: string
          category?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "expenses_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "expense_batches"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          created_at: string | null
          email: string
          id: string
          balance: number | null
          is_active: boolean | null
          name: string
          updated_at: string | null
          user_id: string
          reporting_engineer_id: string | null
          cashier_assigned_engineer_id: string | null
          assigned_cashier_id: string | null
          cashier_assigned_location_id: string | null
          organization_id: string | null
          is_master_admin: boolean | null
          employee_id: string | null
          preferred_language: string
        }
        Insert: {
          created_at?: string | null
          email: string
          id?: string
          balance?: number | null
          is_active?: boolean | null
          name: string
          updated_at?: string | null
          user_id: string
          reporting_engineer_id?: string | null
          cashier_assigned_engineer_id?: string | null
          assigned_cashier_id?: string | null
          cashier_assigned_location_id?: string | null
          organization_id?: string | null
          is_master_admin?: boolean | null
          employee_id?: string | null
          preferred_language?: string
        }
        Update: {
          created_at?: string | null
          email?: string
          id?: string
          balance?: number | null
          is_active?: boolean | null
          name?: string
          updated_at?: string | null
          user_id?: string
          reporting_engineer_id?: string | null
          cashier_assigned_engineer_id?: string | null
          assigned_cashier_id?: string | null
          cashier_assigned_location_id?: string | null
          organization_id?: string | null
          is_master_admin?: boolean | null
          employee_id?: string | null
          preferred_language?: string
        }
        Relationships: []
      }
      master_admin_memberships: {
        Row: {
          id: string
          user_id: string
          is_active: boolean | null
          created_at: string | null
          updated_at: string | null
        }
        Insert: {
          id?: string
          user_id: string
          is_active?: boolean | null
          created_at?: string | null
          updated_at?: string | null
        }
        Update: {
          id?: string
          user_id?: string
          is_active?: boolean | null
          created_at?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      organization_features: {
        Row: {
          organization_id: string
          feature_key: string
          enabled: boolean
          updated_at: string
        }
        Insert: {
          organization_id: string
          feature_key: string
          enabled?: boolean
          updated_at?: string
        }
        Update: {
          organization_id?: string
          feature_key?: string
          enabled?: boolean
          updated_at?: string
        }
        Relationships: []
      }
      organization_memberships: {
        Row: {
          id: string
          organization_id: string
          user_id: string
          role: string
          is_active: boolean | null
          is_accountant_cashier: boolean
          created_at: string | null
          updated_at: string | null
        }
        Insert: {
          id?: string
          organization_id: string
          user_id: string
          role: string
          is_active?: boolean | null
          is_accountant_cashier?: boolean
          created_at?: string | null
          updated_at?: string | null
        }
        Update: {
          id?: string
          organization_id?: string
          user_id?: string
          role?: string
          is_active?: boolean | null
          is_accountant_cashier?: boolean
          created_at?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      teams: {
        Row: {
          id: string
          organization_id: string
          name: string
          team_leader_user_id: string | null
          executive_user_id: string | null
          manager_user_id: string | null
          routing_mode: string
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          organization_id: string
          name: string
          team_leader_user_id?: string | null
          executive_user_id?: string | null
          manager_user_id?: string | null
          routing_mode?: string
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          organization_id?: string
          name?: string
          team_leader_user_id?: string | null
          executive_user_id?: string | null
          manager_user_id?: string | null
          routing_mode?: string
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      team_members: {
        Row: {
          team_id: string
          user_id: string
          organization_id: string
          created_at: string
        }
        Insert: {
          team_id: string
          user_id: string
          organization_id: string
          created_at?: string
        }
        Update: {
          team_id?: string
          user_id?: string
          organization_id?: string
          created_at?: string
        }
        Relationships: []
      }
      organization_settings: {
        Row: {
          id: string
          organization_id: string
          engineer_approval_limit: number | null
          attachment_required_above_amount: number | null
          allow_cashier_expense_submission: boolean | null
          batch_expense_attachment_mode: string
          approval_hierarchy_role_labels: Json | null
          created_at: string | null
          updated_at: string | null
        }
        Insert: {
          id?: string
          organization_id: string
          engineer_approval_limit?: number | null
          attachment_required_above_amount?: number | null
          allow_cashier_expense_submission?: boolean | null
          batch_expense_attachment_mode?: string
          approval_hierarchy_role_labels?: Json | null
          created_at?: string | null
          updated_at?: string | null
        }
        Update: {
          id?: string
          organization_id?: string
          engineer_approval_limit?: number | null
          attachment_required_above_amount?: number | null
          allow_cashier_expense_submission?: boolean | null
          batch_expense_attachment_mode?: string
          created_at?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      organizations: {
        Row: {
          id: string
          name: string
          slug: string
          plan: string | null
          logo_url: string | null
          payment_status: string | null
          is_blocked: boolean | null
          last_activity_at: string | null
          created_at: string | null
          updated_at: string | null
          max_users: number | null
          subdomain: string | null
          strategy_slug: string
        }
        Insert: {
          id?: string
          name: string
          slug: string
          plan?: string | null
          logo_url?: string | null
          payment_status?: string | null
          is_blocked?: boolean | null
          last_activity_at?: string | null
          created_at?: string | null
          updated_at?: string | null
          max_users?: number | null
          subdomain?: string | null
          strategy_slug?: string
        }
        Update: {
          id?: string
          name?: string
          slug?: string
          plan?: string | null
          logo_url?: string | null
          payment_status?: string | null
          is_blocked?: boolean | null
          last_activity_at?: string | null
          created_at?: string | null
          updated_at?: string | null
          max_users?: number | null
          subdomain?: string | null
          strategy_slug?: string
        }
        Relationships: []
      }
      strategies: {
        Row: {
          slug: string
          label: string
          description: string | null
          created_at: string
        }
        Insert: {
          slug: string
          label: string
          description?: string | null
          created_at?: string
        }
        Update: {
          slug?: string
          label?: string
          description?: string | null
          created_at?: string
        }
        Relationships: []
      }
      contact_leads: {
        Row: {
          id: string
          full_name: string
          work_email: string
          company: string
          phone: string | null
          role: string | null
          team_size: string | null
          multi_level: boolean
          balance: boolean
          multi_location: boolean
          receipts: boolean
          message: string | null
          consent_privacy: boolean
          consent_marketing: boolean | null
          consent_timestamp: string | null
          consent_version: number | null
          created_at: string | null
        }
        Insert: {
          id?: string
          full_name: string
          work_email: string
          company: string
          phone?: string | null
          role?: string | null
          team_size?: string | null
          multi_level?: boolean
          balance?: boolean
          multi_location?: boolean
          receipts?: boolean
          message?: string | null
          consent_privacy?: boolean
          consent_marketing?: boolean | null
          consent_timestamp?: string | null
          consent_version?: number | null
          created_at?: string | null
        }
        Update: {
          id?: string
          full_name?: string
          work_email?: string
          company?: string
          phone?: string | null
          role?: string | null
          team_size?: string | null
          multi_level?: boolean
          balance?: boolean
          multi_location?: boolean
          receipts?: boolean
          message?: string | null
          consent_privacy?: boolean
          consent_marketing?: boolean | null
          consent_timestamp?: string | null
          consent_version?: number | null
          created_at?: string | null
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          created_at: string | null
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string | null
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string | null
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
      locations: {
        Row: {
          id: string
          name: string
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          name: string
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          name?: string
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      engineer_locations: {
        Row: {
          id: string
          engineer_id: string
          location_id: string
          organization_id: string
          created_at: string
        }
        Insert: {
          id?: string
          engineer_id: string
          location_id: string
          organization_id: string
          created_at?: string
        }
        Update: {
          id?: string
          engineer_id?: string
          location_id?: string
          organization_id?: string
          created_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "engineer_locations_engineer_id_fkey"
            columns: ["engineer_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "engineer_locations_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
        ]
      }
      notifications: {
        Row: {
          id: string
          user_id: string
          type: string
          title: string
          message: string
          expense_id: string | null
          read: boolean
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          user_id: string
          type: string
          title: string
          message: string
          expense_id?: string | null
          read?: boolean
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          user_id?: string
          type?: string
          title?: string
          message?: string
          expense_id?: string | null
          read?: boolean
          created_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "notifications_expense_id_fkey"
            columns: ["expense_id"]
            isOneToOne: false
            referencedRelation: "expenses"
            referencedColumns: ["id"]
          },
        ]
      }
      money_assignments: {
        Row: {
          id: string
          cashier_id: string
          recipient_id: string
          amount: number
          assigned_at: string
          returned_at: string | null
          is_returned: boolean
          return_transaction_id: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          cashier_id: string
          recipient_id: string
          amount: number
          assigned_at?: string
          returned_at?: string | null
          is_returned?: boolean
          return_transaction_id?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          cashier_id?: string
          recipient_id?: string
          amount?: number
          assigned_at?: string
          returned_at?: string | null
          is_returned?: boolean
          return_transaction_id?: string | null
          created_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "money_assignments_cashier_id_fkey"
            columns: ["cashier_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "money_assignments_recipient_id_fkey"
            columns: ["recipient_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      balance_transfer_offers: {
        Row: {
          id: string
          organization_id: string
          transferrer_id: string
          transferrer_role: string
          recipient_id: string
          recipient_role: string
          amount: number
          status: string
          payment_mode: string
          source_bank_account_id: string | null
          source_bank_name_snapshot: string | null
          source_account_holder_snapshot: string | null
          source_account_number_masked_snapshot: string | null
          transfer_type: string
          note: string | null
          rejection_reason: string | null
          proposed_at: string
          responded_at: string | null
          responded_by: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          organization_id: string
          transferrer_id: string
          transferrer_role: string
          recipient_id: string
          recipient_role: string
          amount: number
          status?: string
          payment_mode?: string
          source_bank_account_id?: string | null
          source_bank_name_snapshot?: string | null
          source_account_holder_snapshot?: string | null
          source_account_number_masked_snapshot?: string | null
          transfer_type: string
          note?: string | null
          rejection_reason?: string | null
          proposed_at?: string
          responded_at?: string | null
          responded_by?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          organization_id?: string
          transferrer_id?: string
          transferrer_role?: string
          recipient_id?: string
          recipient_role?: string
          amount?: number
          status?: string
          payment_mode?: string
          source_bank_account_id?: string | null
          source_bank_name_snapshot?: string | null
          source_account_holder_snapshot?: string | null
          source_account_number_masked_snapshot?: string | null
          transfer_type?: string
          note?: string | null
          rejection_reason?: string | null
          proposed_at?: string
          responded_at?: string | null
          responded_by?: string | null
          created_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "balance_transfer_offers_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      money_return_requests: {
        Row: {
          id: string
          requester_id: string
          cashier_id: string
          amount: number
          note: string | null
          status: string
          requested_at: string
          approved_at: string | null
          rejected_at: string | null
          approved_by: string | null
          rejected_by: string | null
          rejection_reason: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          requester_id: string
          cashier_id: string
          amount: number
          note?: string | null
          status?: string
          requested_at?: string
          approved_at?: string | null
          rejected_at?: string | null
          approved_by?: string | null
          rejected_by?: string | null
          rejection_reason?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          requester_id?: string
          cashier_id?: string
          amount?: number
          note?: string | null
          status?: string
          requested_at?: string
          approved_at?: string | null
          rejected_at?: string | null
          approved_by?: string | null
          rejected_by?: string | null
          rejection_reason?: string | null
          created_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "money_return_requests_requester_id_fkey"
            columns: ["requester_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "money_return_requests_cashier_id_fkey"
            columns: ["cashier_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      sync_engineers_with_location_cashier: {
        Args: {
          location_id_param: string
        }
        Returns: undefined
      }
      get_cashier_for_engineer: {
        Args: {
          engineer_user_id: string
        }
        Returns: string | null
      }
      get_storage_metrics: {
        Args: Record<string, never>
        Returns: Json
      }
      assign_user_to_organization: {
        Args: {
          p_user_id: string
          p_organization_id: string
          p_role?: string
        }
        Returns: undefined
      }
      get_organization_member_counts: {
        Args: {
          org_ids?: string[] | null
        }
        Returns: {
          organization_id: string
          member_count: number
        }[]
      }
      get_organization_by_subdomain: {
        Args: {
          p_subdomain: string
        }
        Returns: {
          id: string
          name: string
          slug: string
        }[]
      }
      list_organizations_for_dev_login: {
        Args: Record<string, never>
        Returns: {
          id: string
          name: string
          slug: string
          subdomain: string
        }[]
      }
      get_organization_feature_enabled: {
        Args: {
          p_organization_id: string
          p_feature_key: string
        }
        Returns: boolean
      }
      get_employee_auth_email: {
        Args: {
          p_organization_id: string
          p_employee_id: string
        }
        Returns: string
      }
      review_approve_expense_v2: {
        Args: {
          p_expense_id: string
          p_comment?: string | null
        }
        Returns: Json
      }
      get_my_balance_transfer_history: {
        Args: {
          p_organization_id: string
          p_limit?: number
          p_offset?: number
        }
        Returns: {
          id: string
          amount: number
          transferred_at: string
          payment_mode: string | null
          transfer_type: string | null
          credited_by_name: string | null
          source_bank_name: string | null
          total_count: number
        }[]
      }
      apply_expense_correction: {
        Args: {
          p_expense_id: string
          p_updates: Json
          p_reason?: string | null
        }
        Returns: Json
      }
      review_advance_expense_hierarchy_tier: {
        Args: {
          p_expense_id: string
          p_next_approval_tier: string
          p_next_assigned_reviewer_id?: string | null
          p_next_assigned_engineer_id?: string | null
          p_comment?: string | null
        }
        Returns: Json
      }
      review_verify_expense: {
        Args: {
          p_expense_id: string
          p_comment?: string | null
        }
        Returns: Json
      }
      review_reject_expense: {
        Args: {
          p_expense_id: string
          p_comment?: string | null
        }
        Returns: Json
      }
      review_admin_verify_expense: {
        Args: {
          p_expense_id: string
          p_comment?: string | null
        }
        Returns: Json
      }
      review_approve_expense: {
        Args: {
          p_expense_id: string
          p_comment?: string | null
        }
        Returns: Json
      }
      propose_balance_transfer_offer: {
        Args: {
          p_organization_id: string
          p_recipient_id: string
          p_amount: number
          p_payment_mode?: string
          p_source_bank_account_id?: string | null
          p_note?: string | null
        }
        Returns: string
      }
      accept_balance_transfer_offer: {
        Args: {
          p_offer_id: string
        }
        Returns: undefined
      }
      reject_balance_transfer_offer: {
        Args: {
          p_offer_id: string
          p_reason: string
        }
        Returns: undefined
      }
      cancel_balance_transfer_offer: {
        Args: {
          p_offer_id: string
        }
        Returns: undefined
      }
    }
    Enums: {
      app_role:
        | "admin"
        | "engineer"
        | "employee"
        | "cashier"
        | "team_leader"
        | "executive"
        | "master_admin"
      expense_category: "travel" | "lodging" | "food" | "other"
      expense_status:
        | "draft"
        | "submitted"
        | "under_review"
        | "verified"
        | "approved"
        | "rejected"
        | "paid"
        | "edited"
        | "level_1_verified"
        | "level_2_verified"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["admin", "engineer", "employee"],
      expense_category: ["travel", "lodging", "food", "other"],
      expense_status: [
        "draft",
        "submitted",
        "under_review",
        "verified",
        "approved",
        "rejected",
        "paid",
        "edited",
      ],
    },
  },
} as const
