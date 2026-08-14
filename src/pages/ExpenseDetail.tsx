import { useEffect, useState } from "react";
import { useTranslation } from "@/i18n";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { 
  ArrowLeft, 
  Edit, 
  Download, 
  FileText, 
  Calendar, 
  MapPin, 
  Coins, 
  User, 
  Clock,
  CheckCircle,
  XCircle,
  Eye,
  ExternalLink
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useAllowCashierExpenseSubmission } from "@/hooks/useAllowCashierExpenseSubmission";
import { format } from "date-fns";
import { ExpenseStatusWithCorrectionBadge } from "@/components/ExpenseStatusWithCorrectionBadge";
import { canOwnerEditExpenseStatus } from "@/lib/expenseEditRules";
import { formatINR, formatCreatedDateTime, parseLocalDate } from "@/lib/format";
import { getDateLocale } from "@/lib/formatLocale";
import { enrichAuditLogsWithDisplay } from "@/lib/auditLogDisplay";
import { ExpenseTimeline } from "@/components/ExpenseTimeline";
import { ExpenseService } from "@/services/ExpenseService";
import { BatchExpenseContextCard } from "@/components/BatchExpenseContextCard";
import { ExpenseFormFieldsDisplay } from "@/components/ExpenseFormFieldsDisplay";
import { useOrganizationExpenseFormConfig } from "@/hooks/useOrganizationExpenseFormConfig";
import { AttachmentPreviewDialog } from "@/components/AttachmentPreviewDialog";
import { normalizeReceiptPublicUrl } from "@/lib/attachmentPreview";
import { fetchExpenseCustomFieldsMap } from "@/lib/expenseCustomFieldFilters";
import {
  fetchExpenseSubmitterProfiles,
  fetchProfileNamesByUserIds,
} from "@/lib/supabaseInQuery";

interface Expense {
  id: string;
  title: string;
  destination: string;
  trip_start: string;
  trip_end: string;
  status: string;
  total_amount: number;
  created_at: string;
  updated_at: string;
  user_id: string;
  user_name: string;
  user_email: string;
  purpose?: string;
  admin_comment?: string;
  assigned_engineer_id?: string;
  assigned_engineer_name?: string;
  approval_tier?: string | null;
  assigned_reviewer_id?: string | null;
  category?: string | null;
  batch_id?: string | null;
  transaction_number?: string | null;
  organization_id?: string;
}

interface BatchSibling {
  id: string;
  title: string;
  total_amount: number;
  status: string;
  transaction_number?: string | null;
}

interface BatchInfo {
  id: string;
  label?: string | null;
  line_count: number;
  total_amount: number;
  created_at: string;
}

interface LineItem {
  id: string;
  date: string;
  category: string;
  amount: number;
  description: string;
}

interface Attachment {
  id: string;
  filename: string;
  content_type: string;
  file_url: string;
  created_at: string;
}

interface AuditLog {
  id: string;
  action: string;
  comment?: string;
  created_at: string;
  user_name: string;
}

export default function ExpenseDetail() {
  const { t, i18n } = useTranslation(["expenses", "common"]);
  const { id } = useParams();
  const navigate = useNavigate();
  const { user, userRole, organizationId, organization, isAccountantCashier, userProfile, loading: authLoading } = useAuth();
  const effectiveOrganizationId = organizationId ?? userProfile?.organization_id ?? null;
  const { getFieldLabel: getBaseFieldLabel, isVisibleOnDetail } = useOrganizationExpenseFormConfig(effectiveOrganizationId);
  const moneyLocale = getDateLocale(i18n.language);
  const { allowCashierExpenseSubmission } = useAllowCashierExpenseSubmission();
  const { toast } = useToast();
  
  const [expense, setExpense] = useState<Expense | null>(null);
  const [lineItems, setLineItems] = useState<LineItem[]>([]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [imagePreviewOpen, setImagePreviewOpen] = useState(false);
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null);
  const [previewContentType, setPreviewContentType] = useState<string | null>(null);
  const [previewUploadedBy, setPreviewUploadedBy] = useState<string | null>(null);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [wasReviewerCorrected, setWasReviewerCorrected] = useState(false);
  const [batchInfo, setBatchInfo] = useState<BatchInfo | null>(null);
  const [batchSiblings, setBatchSiblings] = useState<BatchSibling[]>([]);
  const [customFields, setCustomFields] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!id || authLoading) return;
    if (!effectiveOrganizationId) return;
    void fetchExpenseDetails();
  }, [id, effectiveOrganizationId, authLoading]);

  const fetchExpenseDetails = async () => {
    try {
      setLoading(true);
      setWasReviewerCorrected(false);
      setCustomFields({});

      const orgId = effectiveOrganizationId;
      if (!orgId) {
        return;
      }

      // Fetch expense data (filtered by organization_id)
      const { data: expenseData, error: expenseError } = await supabase
        .from("expenses")
        .select("*")
        .eq("id", id)
        .eq("organization_id", orgId)
        .maybeSingle();

      if (expenseError) throw expenseError;
      if (!expenseData) {
        setExpense(null);
        return;
      }

      // Fetch submitter profile (RPC avoids profiles RLS 406 for admins/reviewers)
      let submitterName = "Unknown User";
      let submitterEmail = "";
      if (orgId && expenseData.user_id) {
        const profiles = await fetchExpenseSubmitterProfiles(supabase, orgId, [
          expenseData.user_id,
        ]);
        const submitter = profiles[0];
        if (submitter) {
          submitterName = submitter.name;
          submitterEmail = submitter.email;
        }
      } else {
        const { data: userProfile } = await supabase
          .from("profiles")
          .select("name, email")
          .eq("user_id", expenseData.user_id)
          .maybeSingle();
        if (userProfile) {
          submitterName = userProfile.name?.trim() || submitterName;
          submitterEmail = userProfile.email?.trim() || "";
        }
      }

      // Fetch engineer profile if assigned
      let engineerProfile: { name: string } | null = null;
      if (expenseData.assigned_engineer_id) {
        const nameByUserId = await fetchProfileNamesByUserIds(supabase, [
          expenseData.assigned_engineer_id,
        ]);
        const engineerName = nameByUserId.get(expenseData.assigned_engineer_id.toLowerCase());
        if (engineerName) {
          engineerProfile = { name: engineerName };
        }
      }

      // Check if user has permission to view this expense
      const canView =
        expenseData.user_id === user?.id ||
        expenseData.assigned_engineer_id === user?.id ||
        expenseData.assigned_reviewer_id === user?.id ||
        userRole === "admin" ||
        (isAccountantCashier &&
          ["verified", "approved"].includes(String(expenseData.status || "")));

      if (!canView) {
        toast({
          variant: "destructive",
          title: t("form.accessDenied"),
          description: t("common:notAuthorized"),
        });
        navigate("/expenses");
        return;
      }

      setExpense({
        ...expenseData,
        user_name: submitterName,
        user_email: submitterEmail,
        assigned_engineer_name: engineerProfile?.name,
        total_amount: Number(expenseData.total_amount),
        organization_id: String(expenseData.organization_id ?? orgId),
      });

      const expenseOrgId = String(expenseData.organization_id ?? orgId);
      try {
        const customByExpense = await fetchExpenseCustomFieldsMap(expenseOrgId, [
          expenseData.id as string,
        ]);
        setCustomFields(customByExpense[expenseData.id as string] ?? {});
      } catch (customFieldErr) {
        console.warn("ExpenseDetail custom fields:", customFieldErr);
      }

      const correctionIds = await ExpenseService.getExpenseIdsWithReviewerCorrections(
        [id as string],
        expenseOrgId,
      );
      setWasReviewerCorrected(correctionIds.has(id as string));

      if (expenseData.batch_id) {
        const { data: batchRow } = await supabase
          .from("expense_batches")
          .select("id, label, line_count, total_amount, created_at")
          .eq("id", expenseData.batch_id)
          .eq("organization_id", expenseOrgId)
          .maybeSingle();

        if (batchRow) {
          setBatchInfo(batchRow);
        } else {
          setBatchInfo(null);
        }

        const { data: siblings } = await supabase
          .from("expenses")
          .select("id, title, total_amount, status, transaction_number")
          .eq("batch_id", expenseData.batch_id)
          .eq("organization_id", expenseOrgId)
          .order("created_at", { ascending: true });

        setBatchSiblings(
          (siblings || []).map((row) => ({
            ...row,
            total_amount: Number(row.total_amount),
          })),
        );
      } else {
        setBatchInfo(null);
        setBatchSiblings([]);
      }

      // Fetch line items (filtered by organization_id)
      const { data: lineItemsData, error: lineItemsError } = await supabase
        .from("expense_line_items")
        .select("*")
        .eq("expense_id", id)
        .eq("organization_id", expenseOrgId)
        .order("date");

      if (lineItemsError) throw lineItemsError;
      setLineItems(lineItemsData || []);

      // Fetch attachments (filtered by organization_id)
      const { data: attachmentsData, error: attachmentsError } = await supabase
        .from("attachments")
        .select("*")
        .eq("expense_id", id)
        .eq("organization_id", expenseOrgId)
        .order("created_at");

      if (attachmentsError) throw attachmentsError;
      // Normalize attachment URLs to ensure they are valid public URLs from the active bucket
      const normalizedAttachments = (attachmentsData || []).map((att) => ({
        ...att,
        file_url: normalizeReceiptPublicUrl(att.file_url || ""),
      }));

      setAttachments(normalizedAttachments);

      // Fetch audit logs including resubmission (filtered by organization_id)
      const { data: auditData, error: auditError } = await supabase
        .from("audit_logs")
        .select("*")
        .eq("expense_id", id)
        .eq("organization_id", expenseOrgId)
        .in("action", ["expense_created", "expense_submitted", "expense_resubmitted", "expense_verified", "expense_approved", "expense_rejected"])
        .order("created_at", { ascending: false });

      if (auditError) throw auditError;

      const enriched = await enrichAuditLogsWithDisplay(
        (auditData || []).map((log) => ({
          user_id: log.user_id,
          action: log.action,
          comment: log.comment,
          created_at: log.created_at,
        })),
      );

      setAuditLogs(
        enriched.map((log, i) => ({
          id: (auditData || [])[i]?.id ?? String(i),
          ...log,
        })),
      );

    } catch (error) {
      console.error("Error fetching expense details:", error);
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to load expense details",
      });
    } finally {
      setLoading(false);
    }
  };

  const canEdit = () => {
    if (!expense) return false;
    if (isAccountantCashier) return false;
    if (userRole === "cashier") {
      return (
        allowCashierExpenseSubmission === true &&
        expense.user_id === user?.id &&
        canOwnerEditExpenseStatus(expense.status)
      );
    }
    if (userRole === "admin") {
      return expense.status !== "approved" && expense.status !== "paid";
    }
    return expense.user_id === user?.id && canOwnerEditExpenseStatus(expense.status);
  };

  const handleExportPDF = () => {
    if (!expense) return;

    // Create a printable HTML content
    const printContent = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Expense Receipt - ${expense.title}</title>
          <style>
            @media print {
              @page { margin: 20mm; }
            }
            body {
              font-family: Arial, sans-serif;
              padding: 20px;
              max-width: 800px;
              margin: 0 auto;
            }
            .header {
              text-align: center;
              border-bottom: 2px solid #000;
              padding-bottom: 20px;
              margin-bottom: 30px;
            }
            .header h1 {
              margin: 0;
              font-size: 24px;
            }
            .header p {
              margin: 5px 0;
              color: #666;
            }
            .section {
              margin-bottom: 25px;
            }
            .section-title {
              font-weight: bold;
              font-size: 16px;
              margin-bottom: 10px;
              border-bottom: 1px solid #ddd;
              padding-bottom: 5px;
            }
            .row {
              display: flex;
              justify-content: space-between;
              padding: 8px 0;
              border-bottom: 1px solid #f0f0f0;
            }
            .label {
              font-weight: bold;
              color: #666;
            }
            .value {
              text-align: right;
            }
            .amount {
              font-size: 24px;
              font-weight: bold;
              color: #2563eb;
            }
            .status {
              display: inline-block;
              padding: 4px 12px;
              border-radius: 12px;
              font-size: 12px;
              font-weight: bold;
              text-transform: uppercase;
            }
            .status-submitted { background: #fef3c7; color: #92400e; }
            .status-verified { background: #dbeafe; color: #1e40af; }
            .status-approved { background: #d1fae5; color: #065f46; }
            .status-rejected { background: #fee2e2; color: #991b1b; }
            .attachments {
              margin-top: 20px;
            }
            .attachment-item {
              padding: 10px;
              background: #f9fafb;
              margin: 5px 0;
              border-radius: 4px;
            }
            .footer {
              margin-top: 40px;
              padding-top: 20px;
              border-top: 2px solid #000;
              text-align: center;
              color: #666;
              font-size: 12px;
            }
          </style>
        </head>
        <body>
          <div class="header">
            <h1>EXPENSE RECEIPT</h1>
            ${organization?.name ? `<p style="font-size: 18px; font-weight: bold; margin: 10px 0;">${organization.name}</p>` : ''}
            <p>PesoWise - Powered by Unimisk</p>
          </div>

          <div class="section">
            <div class="section-title">Expense Details</div>
            <div class="row">
              <span class="label">Transaction #:</span>
              <span class="value">${(expense as any).transaction_number || 'N/A'}</span>
            </div>
            <div class="row">
              <span class="label">Title:</span>
              <span class="value">${expense.title}</span>
            </div>
            <div class="row">
              <span class="label">Destination:</span>
              <span class="value">${expense.destination}</span>
            </div>
            <div class="row">
              <span class="label">Date of Expense:</span>
              <span class="value">${format(parseLocalDate(expense.trip_start) ?? new Date(expense.trip_start), "MMM d, yyyy")}</span>
            </div>
            ${expense.purpose ? `
            <div class="row">
              <span class="label">Purpose:</span>
              <span class="value">${expense.purpose}</span>
            </div>
            ` : ''}
            <div class="row">
              <span class="label">Category:</span>
              <span class="value">${(expense as any).category || 'N/A'}</span>
            </div>
            <div class="row">
              <span class="label">Status:</span>
              <span class="value">
                <span class="status status-${expense.status}">${expense.status}</span>
              </span>
            </div>
          </div>

          <div class="section">
            <div class="section-title">Employee Information</div>
            <div class="row">
              <span class="label">Employee Name:</span>
              <span class="value">${expense.user_name}</span>
            </div>
            <div class="row">
              <span class="label">Email:</span>
              <span class="value">${expense.user_email}</span>
            </div>
            ${expense.assigned_engineer_name ? `
            <div class="row">
              <span class="label">Assigned Manager:</span>
              <span class="value">${expense.assigned_engineer_name}</span>
            </div>
            ` : ''}
          </div>

          <div class="section">
            <div class="section-title">Amount</div>
            <div class="row">
              <span class="label">Total Amount:</span>
              <span class="value amount">${formatINR(expense.total_amount)}</span>
            </div>
          </div>

          ${attachments.length > 0 ? `
          <div class="section attachments">
            <div class="section-title">Attachments</div>
            ${attachments.map(att => `
              <div class="attachment-item">
                <strong>${att.filename}</strong><br>
                <small>${att.content_type} • ${format(new Date(att.created_at), "MMM d, yyyy")}</small>
              </div>
            `).join('')}
          </div>
          ` : ''}

          ${expense.admin_comment ? `
          <div class="section">
            <div class="section-title">Admin Comments</div>
            <p>${expense.admin_comment}</p>
          </div>
          ` : ''}

          <div class="footer">
            <p>Generated on ${format(new Date(), "MMM d, yyyy 'at' h:mm a")}</p>
            <p>This is a computer-generated receipt.</p>
          </div>
        </body>
      </html>
    `;

    // Open print window
    const printWindow = window.open('', '_blank');
    if (printWindow) {
      printWindow.document.write(printContent);
      printWindow.document.close();
      printWindow.onload = () => {
        setTimeout(() => {
          printWindow.print();
        }, 250);
      };
    }
  };

  const handlePrintReceipt = () => {
    if (!expense) return;

    // Create a printable HTML content (same as PDF but optimized for printing)
    const printContent = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Expense Receipt - ${expense.title}</title>
          <style>
            @media print {
              @page { margin: 15mm; size: A4; }
              body { margin: 0; }
            }
            body {
              font-family: Arial, sans-serif;
              padding: 20px;
              max-width: 800px;
              margin: 0 auto;
            }
            .header {
              text-align: center;
              border-bottom: 2px solid #000;
              padding-bottom: 20px;
              margin-bottom: 30px;
            }
            .header h1 {
              margin: 0;
              font-size: 28px;
            }
            .header p {
              margin: 5px 0;
              color: #666;
            }
            .section {
              margin-bottom: 25px;
            }
            .section-title {
              font-weight: bold;
              font-size: 18px;
              margin-bottom: 10px;
              border-bottom: 2px solid #000;
              padding-bottom: 5px;
            }
            .row {
              display: flex;
              justify-content: space-between;
              padding: 10px 0;
              border-bottom: 1px solid #e5e7eb;
            }
            .label {
              font-weight: bold;
              color: #374151;
            }
            .value {
              text-align: right;
            }
            .amount {
              font-size: 32px;
              font-weight: bold;
              color: #2563eb;
            }
            .status {
              display: inline-block;
              padding: 6px 16px;
              border-radius: 16px;
              font-size: 14px;
              font-weight: bold;
              text-transform: uppercase;
            }
            .status-submitted { background: #fef3c7; color: #92400e; }
            .status-verified { background: #dbeafe; color: #1e40af; }
            .status-approved { background: #d1fae5; color: #065f46; }
            .status-rejected { background: #fee2e2; color: #991b1b; }
            .footer {
              margin-top: 50px;
              padding-top: 20px;
              border-top: 2px solid #000;
              text-align: center;
              color: #666;
              font-size: 14px;
            }
          </style>
        </head>
        <body>
          <div class="header">
            <h1>EXPENSE RECEIPT</h1>
            ${organization?.name ? `<p style="font-size: 18px; font-weight: bold; margin: 10px 0;">${organization.name}</p>` : ''}
            <p>PesoWise - Powered by Unimisk</p>
          </div>

          <div class="section">
            <div class="section-title">Expense Details</div>
            <div class="row">
              <span class="label">Transaction #:</span>
              <span class="value">${(expense as any).transaction_number || 'N/A'}</span>
            </div>
            <div class="row">
              <span class="label">Title:</span>
              <span class="value">${expense.title}</span>
            </div>
            <div class="row">
              <span class="label">Destination:</span>
              <span class="value">${expense.destination}</span>
            </div>
            <div class="row">
              <span class="label">Date of Expense:</span>
              <span class="value">${format(parseLocalDate(expense.trip_start) ?? new Date(expense.trip_start), "MMM d, yyyy")}</span>
            </div>
            ${expense.purpose ? `
            <div class="row">
              <span class="label">Purpose:</span>
              <span class="value">${expense.purpose}</span>
            </div>
            ` : ''}
            <div class="row">
              <span class="label">Category:</span>
              <span class="value">${(expense as any).category || 'N/A'}</span>
            </div>
            <div class="row">
              <span class="label">Status:</span>
              <span class="value">
                <span class="status status-${expense.status}">${expense.status}</span>
              </span>
            </div>
          </div>

          <div class="section">
            <div class="section-title">Employee Information</div>
            <div class="row">
              <span class="label">Employee Name:</span>
              <span class="value">${expense.user_name}</span>
            </div>
            <div class="row">
              <span class="label">Email:</span>
              <span class="value">${expense.user_email}</span>
            </div>
            ${expense.assigned_engineer_name ? `
            <div class="row">
              <span class="label">Assigned Manager:</span>
              <span class="value">${expense.assigned_engineer_name}</span>
            </div>
            ` : ''}
          </div>

          <div class="section">
            <div class="section-title">Amount</div>
            <div class="row">
              <span class="label">Total Amount:</span>
              <span class="value amount">${formatINR(expense.total_amount)}</span>
            </div>
          </div>

          ${attachments.length > 0 ? `
          <div class="section">
            <div class="section-title">Attachments</div>
            ${attachments.map(att => `
              <div style="padding: 10px; background: #f9fafb; margin: 5px 0; border-radius: 4px;">
                <strong>${att.filename}</strong><br>
                <small>${att.content_type} • ${format(new Date(att.created_at), "MMM d, yyyy")}</small>
              </div>
            `).join('')}
          </div>
          ` : ''}

          ${expense.admin_comment ? `
          <div class="section">
            <div class="section-title">Admin Comments</div>
            <p>${expense.admin_comment}</p>
          </div>
          ` : ''}

          <div class="footer">
            <p>Generated on ${format(new Date(), "MMM d, yyyy 'at' h:mm a")}</p>
            <p>This is a computer-generated receipt.</p>
          </div>
        </body>
      </html>
    `;

    // Open print window
    const printWindow = window.open('', '_blank');
    if (printWindow) {
      printWindow.document.write(printContent);
      printWindow.document.close();
      printWindow.onload = () => {
        setTimeout(() => {
          printWindow.print();
        }, 250);
      };
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "approved":
        return <CheckCircle className="h-4 w-4 text-green-600" />;
      default:
        return <Clock className="h-4 w-4 text-yellow-600" />;
    }
  };

  const getCategoryIcon = (category: string) => {
    switch (category) {
      case "travel":
        return "✈️";
      case "lodging":
        return "🏨";
      case "food":
        return "🍽️";
      default:
        return "📄";
    }
  };

  const getFileIcon = (contentType: string) => {
    if (contentType.startsWith('image/')) {
      return "🖼️";
    } else if (contentType === 'application/pdf') {
      return "📄";
    } else if (contentType.includes('word')) {
      return "📝";
    }
    return "📎";
  };

  if (loading) {
    return (
      <div className="space-y-8">
        <div className="flex items-center gap-4">
          <Button variant="ghost" onClick={() => navigate("/expenses")}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            {t("backToExpenses")}
          </Button>
        </div>
        <div className="text-center py-8">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto"></div>
          <p className="text-muted-foreground mt-2">{t("loadingDetail")}</p>
        </div>
      </div>
    );
  }

  if (!expense) {
    return (
      <div className="space-y-8">
        <div className="flex items-center gap-4">
          <Button variant="ghost" onClick={() => navigate("/expenses")}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            {t("backToExpenses")}
          </Button>
        </div>
        <div className="text-center py-8">
          <h2 className="text-2xl font-bold">{t("notFound")}</h2>
          <p className="text-muted-foreground">{t("notFoundDescription")}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button variant="ghost" onClick={() => navigate("/expenses")}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            {t("backToExpenses")}
          </Button>
          <div>
            <h1 className="text-3xl font-bold tracking-tight">{expense.title}</h1>
            <p className="text-muted-foreground">
              {t("createdOn", { date: formatCreatedDateTime(expense.created_at) })}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {canEdit() && (
            <Button onClick={() => navigate(`/expenses/${expense.id}/edit`)}>
              <Edit className="h-4 w-4 mr-2" />
              {t("actions.edit")}
            </Button>
          )}
          <Button variant="outline">
            <Download className="h-4 w-4 mr-2" />
            {t("export")}
          </Button>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Main Content */}
        <div className="lg:col-span-2 space-y-6">
          {batchInfo && expense && (
            <BatchExpenseContextCard
              batchInfo={{
                id: batchInfo.id,
                label: batchInfo.label ?? null,
                line_count: batchInfo.line_count,
                total_amount: batchInfo.total_amount,
                created_at: batchInfo.created_at,
              }}
              siblings={batchSiblings}
              currentExpenseId={expense.id}
              userId={user?.id}
              userRole={userRole}
              variant="view"
            />
          )}

          {/* Expense Overview */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                {getStatusIcon(expense.status)}
                Expense Overview
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <User className="h-4 w-4" />
                    Employee
                  </div>
                  <div>
                    <p className="font-medium">{expense.user_name}</p>
                    <p className="text-sm text-muted-foreground">{expense.user_email}</p>
                  </div>
                </div>
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Coins className="h-4 w-4" />
                    Total Amount
                  </div>
                  <p className="text-2xl font-bold">{formatINR(expense.total_amount)}</p>
                </div>
              </div>

              <Separator />

              {isVisibleOnDetail("destination") && (
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <MapPin className="h-4 w-4" />
                      {getBaseFieldLabel("destination")}
                    </div>
                    <p className="font-medium">{expense.destination}</p>
                  </div>
                  {isVisibleOnDetail("expense_date") && (
                    <div className="space-y-2">
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Calendar className="h-4 w-4" />
                        {getBaseFieldLabel("expense_date")}
                      </div>
                      <p className="font-medium">
                        {format(parseLocalDate(expense.trip_start) ?? new Date(expense.trip_start), "MMM d, yyyy")}
                      </p>
                    </div>
                  )}
                </div>
              )}

              <Separator />

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Clock className="h-4 w-4" />
                    {t("dateCreated")}
                  </div>
                  <p className="font-medium">{formatCreatedDateTime(expense.created_at)}</p>
                </div>
              </div>

              {expense.category && isVisibleOnDetail("category") && (
                <>
                  <Separator />
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <FileText className="h-4 w-4" />
                      {getBaseFieldLabel("category")}
                    </div>
                    <p className="font-medium capitalize">{expense.category}</p>
                  </div>
                </>
              )}

              {expense.purpose && isVisibleOnDetail("purpose") && (
                <>
                  <Separator />
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <FileText className="h-4 w-4" />
                      {getBaseFieldLabel("purpose")}
                    </div>
                    <p className="text-sm">{expense.purpose}</p>
                  </div>
                </>
              )}

              <Separator />

              <div className="flex items-center justify-between">
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Clock className="h-4 w-4" />
                    Status
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <ExpenseStatusWithCorrectionBadge
                      status={expense.status}
                      wasReviewerCorrected={wasReviewerCorrected}
                      viewerContext={expense.user_id === user?.id ? "owner" : "reviewer"}
                    />
                    {expense.approval_tier ? (
                      <Badge variant="outline" className="capitalize">
                        Tier: {expense.approval_tier.replace(/_/g, " ")}
                      </Badge>
                    ) : null}
                  </div>
                </div>
                {expense.assigned_engineer_name && (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <User className="h-4 w-4" />
                      Assigned Manager
                    </div>
                    <p className="font-medium">{expense.assigned_engineer_name}</p>
                  </div>
                )}
              </div>

              {(expense as any).transaction_number && (
                <>
                  <Separator />
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <FileText className="h-4 w-4" />
                      Transaction Number
                    </div>
                    <p className="text-lg font-mono font-bold text-blue-600">{(expense as any).transaction_number}</p>
                    <p className="text-xs text-muted-foreground">Use this number to track the expense in Tally</p>
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          {id && (expense?.organization_id ?? effectiveOrganizationId) && (
            <ExpenseFormFieldsDisplay
              key={`${id}-${Object.keys(customFields).sort().join(",")}`}
              expenseId={id}
              organizationId={expense?.organization_id ?? effectiveOrganizationId ?? ""}
              context="detail"
              variant="card"
              prefetchedFields={customFields}
            />
          )}

          {/* Line Items */}
          <Card>
            <CardHeader>
              <CardTitle>Expense Line Items</CardTitle>
              <CardDescription>
                Detailed breakdown of all expense items
              </CardDescription>
            </CardHeader>
            <CardContent>
              {lineItems.length === 0 ? (
                <p className="text-muted-foreground text-center py-4">
                  No line items found
                </p>
              ) : (
                <div className="space-y-3">
                  {lineItems.map((item) => (
                    <div key={item.id} className="flex items-center justify-between p-4 border rounded-lg">
                      <div className="flex items-center gap-3">
                        <span className="text-lg">{getCategoryIcon(item.category)}</span>
                        <div>
                          <p className="font-medium capitalize">{item.category}</p>
                          <p className="text-sm text-muted-foreground">{item.description}</p>
                          <p className="text-xs text-muted-foreground">
                            {format(new Date(item.date), "MMM d, yyyy")}
                          </p>
                        </div>
                      </div>
                      <div className="text-right">
                        <p className="font-semibold">{formatINR(item.amount)}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Attachments */}
          {attachments.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Receipts & Attachments</CardTitle>
                <CardDescription>
                  Supporting documents and receipts
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {attachments.map((attachment) => (
                    <div key={attachment.id} className="flex items-center justify-between p-3 border rounded-lg">
                      <div className="flex items-center gap-3">
                        <span className="text-lg">{getFileIcon(attachment.content_type)}</span>
                        <div>
                          <p className="font-medium">{attachment.filename}</p>
                          <p className="text-sm text-muted-foreground">
                            {attachment.content_type} • {format(new Date(attachment.created_at), "MMM d, yyyy")}
                          </p>
                        </div>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setImagePreviewUrl(attachment.file_url);
                          setPreviewContentType(attachment.content_type);
                          setPreviewUploadedBy(expense.user_id);
                          setImagePreviewOpen(true);
                        }}
                      >
                        <Eye className="h-4 w-4 mr-2" />
                        View
                      </Button>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          <AttachmentPreviewDialog
            open={imagePreviewOpen}
            onOpenChange={setImagePreviewOpen}
            url={imagePreviewUrl}
            contentType={previewContentType}
            uploadedBy={previewUploadedBy}
            expenseId={expense?.id ?? null}
          />

          {/* Admin Comments */}
          {expense.admin_comment && (
            <Card>
              <CardHeader>
                <CardTitle>Admin Comments</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm">{expense.admin_comment}</p>
              </CardContent>
            </Card>
          )}
        </div>

        {/* Sidebar */}
        <div className="space-y-6">
          {/* Status Timeline */}
          <Card>
            <CardHeader>
              <CardTitle>Status Timeline</CardTitle>
              <CardDescription>
                Track the progress of this expense
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <ExpenseTimeline logs={auditLogs} />
              </div>
            </CardContent>
          </Card>

          {/* Quick Actions */}
          <Card>
            <CardHeader>
              <CardTitle>Quick Actions</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <Button 
                variant="outline" 
                className="w-full justify-start"
                onClick={handleExportPDF}
              >
                <Download className="h-4 w-4 mr-2" />
                Export as PDF
              </Button>
              <Button 
                variant="outline" 
                className="w-full justify-start"
                onClick={handlePrintReceipt}
              >
                <FileText className="h-4 w-4 mr-2" />
                Print Receipt
              </Button>
              {canEdit() && (
                <Button 
                  className="w-full justify-start"
                  onClick={() => navigate(`/expenses/${id}/edit`)}
                >
                  <Edit className="h-4 w-4 mr-2" />
                  {expense?.status === "rejected" ? "Edit & Resubmit" : "Edit Expense"}
                </Button>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
