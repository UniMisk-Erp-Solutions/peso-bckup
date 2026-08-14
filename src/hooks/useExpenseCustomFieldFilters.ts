import { useEffect, useState } from "react";
import {
  buildInitialCustomFieldFilters,
  fetchFilterableCustomFields,
  type FetchFilterableCustomFieldsOptions,
  type FilterableCustomField,
} from "@/lib/expenseCustomFieldFilters";

export function useExpenseCustomFieldFilters(
  organizationId: string | null | undefined,
  options?: FetchFilterableCustomFieldsOptions,
) {
  const [filterableCustomFields, setFilterableCustomFields] = useState<FilterableCustomField[]>(
    [],
  );
  const [customFieldFilters, setCustomFieldFilters] = useState<Record<string, string>>({});
  const scanExpenseValues = options?.scanExpenseValues ?? false;

  useEffect(() => {
    if (!organizationId) {
      setFilterableCustomFields([]);
      setCustomFieldFilters({});
      return;
    }

    let cancelled = false;

    void fetchFilterableCustomFields(organizationId, { scanExpenseValues })
      .then((fields) => {
        if (cancelled) return;
        setFilterableCustomFields(fields);
        setCustomFieldFilters(buildInitialCustomFieldFilters(fields));
      })
      .catch((error) => {
        console.warn("Failed to load custom field filters", error);
        if (!cancelled) {
          setFilterableCustomFields([]);
          setCustomFieldFilters({});
        }
      });

    return () => {
      cancelled = true;
    };
  }, [organizationId, scanExpenseValues]);

  const resetCustomFieldFilters = () => {
    setCustomFieldFilters(buildInitialCustomFieldFilters(filterableCustomFields));
  };

  return {
    filterableCustomFields,
    customFieldFilters,
    setCustomFieldFilters,
    resetCustomFieldFilters,
  };
}
