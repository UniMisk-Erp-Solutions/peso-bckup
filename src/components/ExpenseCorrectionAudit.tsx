import { format } from "date-fns";
import { History } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import {
  type ExpenseCorrectionLogEntry,
  getCorrectionChanges,
} from "@/lib/expenseCorrectionAudit";

function CorrectionEntry({ log }: { log: ExpenseCorrectionLogEntry }) {
  const changes = getCorrectionChanges(log.before_json, log.after_json);

  return (
    <article className="rounded-lg border bg-card text-sm shadow-sm overflow-hidden">
      <header className="flex flex-wrap items-start justify-between gap-2 border-b bg-muted/30 px-3 py-2.5">
        <div className="flex items-center gap-2 min-w-0">
          <History className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          <time className="font-medium text-foreground" dateTime={log.created_at}>
            {format(new Date(log.created_at), "MMM d, yyyy · h:mm a")}
          </time>
        </div>
      </header>

      {log.reason ? (
        <p className="px-3 py-2 text-sm text-muted-foreground border-b bg-muted/10">
          <span className="font-medium text-foreground">Reason: </span>
          {log.reason}
        </p>
      ) : null}

      {changes.length === 0 ? (
        <p className="px-3 py-3 text-sm text-muted-foreground">No field changes recorded.</p>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-[28%] h-9 text-xs font-semibold">Field</TableHead>
                <TableHead className="w-[36%] h-9 text-xs font-semibold">Previous</TableHead>
                <TableHead className="w-[36%] h-9 text-xs font-semibold">Corrected</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {changes.map((row) => (
                <TableRow key={row.key} className="hover:bg-muted/20">
                  <TableCell className="py-2.5 font-medium text-foreground align-top">
                    {row.label}
                  </TableCell>
                  <TableCell className="py-2.5 align-top text-muted-foreground">
                    <span className="line-through decoration-muted-foreground/60">
                      {row.before}
                    </span>
                  </TableCell>
                  <TableCell className="py-2.5 align-top">
                    <span className="font-medium text-foreground rounded px-1.5 py-0.5 bg-amber-50 text-amber-950 border border-amber-100">
                      {row.after}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </article>
  );
}

export function ExpenseCorrectionAuditList({
  logs,
  className,
  maxHeightClassName = "max-h-64",
}: {
  logs: ExpenseCorrectionLogEntry[];
  className?: string;
  maxHeightClassName?: string;
}) {
  if (logs.length === 0) return null;

  return (
    <div className={cn("space-y-3", maxHeightClassName, "overflow-y-auto pr-1", className)}>
      {logs.map((log) => (
        <CorrectionEntry key={log.id} log={log} />
      ))}
    </div>
  );
}
