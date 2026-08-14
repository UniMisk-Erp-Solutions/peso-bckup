import { useEffect, useState } from "react";
import { GripVertical, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export interface SortableAssignmentItem {
  id: string;
  template_name?: string;
  required?: boolean | null;
  display_order: number;
  ask_once_per_batch?: boolean;
  /** When set, the batch mode is inherited from the template and cannot be overridden per-assignment. */
  batch_entry_mode_from_template?: "once_per_batch" | "per_line" | null;
}

function sortByDisplayOrder(items: SortableAssignmentItem[]) {
  return [...items].sort((a, b) => a.display_order - b.display_order);
}

interface CategoryFieldAssignmentSortListProps {
  items: SortableAssignmentItem[];
  onReorder: (orderedIds: string[]) => Promise<void>;
  onRemove: (id: string) => void;
  onAskOncePerBatchChange?: (assignmentId: string, value: boolean) => void;
  disabled?: boolean;
}

export function CategoryFieldAssignmentSortList({
  items,
  onReorder,
  onRemove,
  onAskOncePerBatchChange,
  disabled = false,
}: CategoryFieldAssignmentSortListProps) {
  const [ordered, setOrdered] = useState(() => sortByDisplayOrder(items));
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setOrdered(sortByDisplayOrder(items));
  }, [items]);

  const clearDragState = () => {
    setDragIndex(null);
    setOverIndex(null);
  };

  const applyReorder = async (fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex || disabled || saving) return;

    const next = [...ordered];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    const previous = ordered;
    setOrdered(next);
    setSaving(true);

    try {
      await onReorder(next.map((item) => item.id));
    } catch {
      setOrdered(previous);
    } finally {
      setSaving(false);
      clearDragState();
    }
  };

  return (
    <ul className="space-y-2" aria-busy={saving}>
      {ordered.map((item, index) => (
        <li
          key={item.id}
          draggable={!disabled && !saving}
          onDragStart={() => setDragIndex(index)}
          onDragEnd={clearDragState}
          onDragOver={(e) => {
            e.preventDefault();
            if (dragIndex !== null && dragIndex !== index) {
              setOverIndex(index);
            }
          }}
          onDragLeave={() => {
            if (overIndex === index) setOverIndex(null);
          }}
          onDrop={(e) => {
            e.preventDefault();
            if (dragIndex !== null) {
              void applyReorder(dragIndex, index);
            } else {
              clearDragState();
            }
          }}
          className={cn(
            "flex flex-col sm:flex-row sm:items-center gap-2 rounded-md border bg-background px-2 py-2 text-sm transition-colors",
            dragIndex === index && "opacity-50",
            overIndex === index && dragIndex !== index && "border-primary bg-primary/5",
            !disabled && !saving && "cursor-grab active:cursor-grabbing"
          )}
        >
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <GripVertical
              className="h-4 w-4 shrink-0 text-muted-foreground"
              aria-hidden
            />
            <span className="flex-1 text-muted-foreground min-w-0">
              <span className="text-xs text-muted-foreground/80 mr-2 tabular-nums">
                {index + 1}.
              </span>
              {item.template_name}
              {item.required && <span className="text-red-500 ml-1">*</span>}
              {item.batch_entry_mode_from_template === "once_per_batch" && (
                <Badge variant="secondary" className="ml-2 text-xs font-normal">
                  once per batch (template)
                </Badge>
              )}
            </span>
          </div>
          {onAskOncePerBatchChange && !item.batch_entry_mode_from_template && (
            <div className="flex items-center gap-2 shrink-0 pl-6 sm:pl-0">
              <Switch
                id={`batch-once-${item.id}`}
                checked={item.ask_once_per_batch === true}
                disabled={disabled || saving}
                onCheckedChange={(checked) => onAskOncePerBatchChange(item.id, checked)}
              />
              <Label htmlFor={`batch-once-${item.id}`} className="text-xs font-normal cursor-pointer">
                Once per batch
              </Label>
            </div>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 w-8 shrink-0"
            disabled={disabled || saving}
            onClick={() => onRemove(item.id)}
            aria-label={`Remove ${item.template_name ?? "field"}`}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </li>
      ))}
    </ul>
  );
}
