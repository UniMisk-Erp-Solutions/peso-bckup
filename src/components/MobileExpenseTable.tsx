import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Eye } from "lucide-react";
import { format } from "date-fns";
import { StatusBadge } from "@/components/StatusBadge";
import { formatINR, formatCreatedDateTime, parseLocalDate } from "@/lib/format";

interface Expense {
  id: string;
  title: string;
  destination: string;
  total_amount: number;
  status: string;
  created_at: string;
  user_name: string;
  user_email: string;
  user_balance: number;
  purpose?: string;
  trip_start: string;
  trip_end: string;
  admin_comment?: string;
}

interface Engineer {
  id: string;
  name: string;
  email: string;
}

interface MobileExpenseTableProps {
  expenses: Expense[];
  engineers: Engineer[];
  selectedStatus: string;
  setSelectedStatus: (status: string) => void;
  selectedEngineer: string;
  setSelectedEngineer: (engineer: string) => void;
  adminComment: string;
  setAdminComment: (comment: string) => void;
  onApprove: () => void;
  onReject: () => void;
  onAssign: () => void;
}

export function MobileExpenseTable({
  expenses,
  engineers,
  selectedStatus,
  setSelectedStatus,
  selectedEngineer,
  setSelectedEngineer,
  adminComment,
  setAdminComment,
  onApprove,
  onReject,
  onAssign,
}: MobileExpenseTableProps) {
  const handleAction = () => {
    if (selectedStatus === "approved") {
      onApprove();
    } else if (selectedStatus === "rejected") {
      onReject();
    } else if (selectedStatus === "under_review") {
      onAssign();
    }
  };

  return (
    <div className="space-y-3">
      {expenses.map((expense) => (
        <Card key={expense.id} className="p-4 hover:shadow-md transition-shadow">
          <div className="space-y-3">
            {/* Header with title and amount */}
            <div className="flex justify-between items-start">
              <div className="min-w-0 flex-1">
                <h3 className="font-semibold text-sm truncate">{expense.title}</h3>
                <p className="text-xs text-gray-500 truncate">{expense.user_name}</p>
              </div>
              <div className="text-right flex-shrink-0 ml-2">
                <p className="font-bold text-sm">{formatINR(expense.total_amount ?? 0)}</p>
                <StatusBadge status={(expense.status || "draft") as any} />
              </div>
            </div>

            {/* Details */}
            <div className="space-y-2 text-xs text-gray-600">
              <div className="flex justify-between">
                <span>Destination:</span>
                <span className="truncate ml-2">{expense.destination || "N/A"}</span>
              </div>
              <div className="flex justify-between">
                <span>Employee Balance:</span>
                <span className={`font-medium ${(expense.user_balance ?? 0) >= (expense.total_amount ?? 0)
                  ? 'text-green-600'
                  : 'text-red-600'
                  }`}>
                  {formatINR(expense.user_balance ?? 0)}
                </span>
              </div>
              <div className="flex justify-between">
                <span>Expense Date:</span>
                <span>{expense.trip_start ? format(parseLocalDate(expense.trip_start) ?? new Date(expense.trip_start), "MMM d, yyyy") : "N/A"}</span>
              </div>
              <div className="flex justify-between">
                <span>Submitted on:</span>
                <span className="text-right ml-2">{formatCreatedDateTime(expense.created_at)}</span>
              </div>
            </div>

            {/* Action Button */}
            <div className="flex gap-2 pt-2">
              <Dialog>
                <DialogTrigger asChild>
                  <Button variant="outline" size="sm" className="flex-1 text-xs">
                    <Eye className="h-3 w-3 mr-1" />
                    View Details
                  </Button>
                </DialogTrigger>
                <DialogContent className="max-w-2xl mx-4 max-h-[90vh] overflow-y-auto">
                  <DialogHeader>
                    <DialogTitle>Expense Details</DialogTitle>
                    <DialogDescription>
                      Review and manage this expense submission
                    </DialogDescription>
                  </DialogHeader>

                  <div className="space-y-4">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <label className="text-sm font-medium">Employee</label>
                        <p className="text-sm text-muted-foreground">{expense.user_name || "Unknown User"}</p>
                        <p className="text-xs text-gray-500">{expense.user_email || "N/A"}</p>
                      </div>
                      <div>
                        <label className="text-sm font-medium">Amount</label>
                        <p className="text-sm text-muted-foreground">{formatINR(expense.total_amount ?? 0)}</p>
                      </div>
                      <div>
                        <label className="text-sm font-medium">Status</label>
                        <div className="mt-1">
                          <StatusBadge status={(expense.status || "draft") as any} />
                        </div>
                      </div>
                      <div>
                        <label className="text-sm font-medium">Expense Date</label>
                        <p className="text-sm text-muted-foreground">{expense.trip_start ? format(parseLocalDate(expense.trip_start) ?? new Date(expense.trip_start), "MMM d, yyyy") : "N/A"}</p>
                      </div>
                      <div>
                        <label className="text-sm font-medium">Submitted on</label>
                        <p className="text-sm text-muted-foreground">{formatCreatedDateTime(expense.created_at)}</p>
                      </div>
                    </div>

                    <div>
                      <label className="text-sm font-medium">Title</label>
                      <p className="text-sm text-muted-foreground">{expense.title || "N/A"}</p>
                    </div>

                    <div>
                      <label className="text-sm font-medium">Destination</label>
                      <p className="text-sm text-muted-foreground">{expense.destination || "N/A"}</p>
                    </div>

                    <div>
                      <label className="text-sm font-medium">Purpose</label>
                      <p className="text-sm text-muted-foreground">{expense.purpose || "No purpose provided"}</p>
                    </div>

                    <div>
                      <label className="text-sm font-medium">Admin Comment</label>
                      <p className="text-sm text-muted-foreground">{expense.admin_comment || "No comment"}</p>
                    </div>
                  </div>

                  <DialogFooter className="flex flex-col gap-3">
                    <div className="w-full">
                      <label className="text-sm font-medium mb-2 block">Action</label>
                      <Select value={selectedStatus} onValueChange={setSelectedStatus}>
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="Select action" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="approved">Approve</SelectItem>
                          <SelectItem value="rejected">Reject</SelectItem>
                          <SelectItem value="under_review">Assign to Manager</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    {selectedStatus === "under_review" && (
                      <div className="w-full">
                        <label className="text-sm font-medium mb-2 block">Select Manager</label>
                        <Select value={selectedEngineer} onValueChange={setSelectedEngineer}>
                          <SelectTrigger className="w-full">
                            <SelectValue placeholder="Select manager" />
                          </SelectTrigger>
                          <SelectContent>
                            {engineers.map((engineer) => (
                              <SelectItem key={engineer.id} value={engineer.id}>
                                {engineer.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}

                    <div className="w-full">
                      <label className="text-sm font-medium mb-2 block">Comment (Optional)</label>
                      <Textarea
                        placeholder="Add comment..."
                        value={adminComment}
                        onChange={(e) => setAdminComment(e.target.value)}
                        className="w-full"
                        rows={3}
                      />
                    </div>

                    <Button
                      onClick={handleAction}
                      className="w-full"
                      disabled={!selectedStatus || (selectedStatus === "under_review" && (!selectedEngineer || selectedEngineer === "none"))}
                    >
                      {selectedStatus === "approved" && "Approve Expense"}
                      {selectedStatus === "rejected" && "Reject Expense"}
                      {selectedStatus === "under_review" && "Assign to Manager"}
                      {!selectedStatus && "Select Action"}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}
