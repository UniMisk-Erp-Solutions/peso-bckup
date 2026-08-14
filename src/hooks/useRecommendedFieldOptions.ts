import { useEffect, useMemo, useState } from "react";
import {
  fetchRecommendedOptionsForFields,
  fieldRecKey,
  type SelectFieldRef,
} from "@/lib/recommendedFormFieldOptions";

export function useRecommendedFieldOptions(
  organizationId: string | null | undefined,
  userId: string | null | undefined,
  fields: SelectFieldRef[],
): Record<string, string[]> {
  const [recommendedByKey, setRecommendedByKey] = useState<Record<string, string[]>>({});

  const fieldsKey = useMemo(
    () =>
      fields
        .map((f) => `${f.fieldKind}:${f.fieldKey}:${f.options.join("|")}`)
        .join(";"),
    [fields],
  );

  useEffect(() => {
    if (!organizationId || !userId || fields.length === 0) {
      setRecommendedByKey({});
      return;
    }

    let cancelled = false;
    void (async () => {
      const map = await fetchRecommendedOptionsForFields(organizationId, userId, fields);
      if (!cancelled) setRecommendedByKey(map);
    })();

    return () => {
      cancelled = true;
    };
    // 'fields' is intentionally excluded: it is an array that may be a new reference on every
    // render even when content is unchanged. 'fieldsKey' is the content-stable derivative that
    // guards re-runs; including 'fields' would cause a query on every single render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizationId, userId, fieldsKey]);

  return recommendedByKey;
}

export { fieldRecKey };
