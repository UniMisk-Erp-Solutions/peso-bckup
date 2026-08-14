import { useEffect, useMemo, useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { fetchExpenseCategoryNames } from "@/lib/fetchExpenseCategoryNames";

type ExpenseCategorySelectProps = {
  id?: string;
  organizationId: string | null | undefined;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
};

export function ExpenseCategorySelect({
  id,
  organizationId,
  value,
  onChange,
  placeholder = "Select category",
}: ExpenseCategorySelectProps) {
  const [categories, setCategories] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!organizationId) {
      setCategories([]);
      return;
    }

    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const names = await fetchExpenseCategoryNames(organizationId);
        if (!cancelled) setCategories(names);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [organizationId]);

  const options = useMemo(() => {
    const trimmed = value.trim();
    if (trimmed && !categories.includes(trimmed)) {
      return [trimmed, ...categories];
    }
    return categories;
  }, [categories, value]);

  return (
    <Select
      value={value || undefined}
      onValueChange={onChange}
      disabled={!organizationId || (loading && options.length === 0)}
    >
      <SelectTrigger id={id}>
        <SelectValue placeholder={loading ? "Loading…" : placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((name) => (
          <SelectItem key={name} value={name}>
            {name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
