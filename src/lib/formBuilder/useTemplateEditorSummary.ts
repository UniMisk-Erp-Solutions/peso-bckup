/**
 * DOC-097 hotfix — fetches the tiny server-computed aggregate summary used
 * for the editor's header badges ("N parent options", "M dependent fields")
 * for an EXISTING template, without ever downloading its options[] array or
 * branch rows.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  getFormTemplateEditorSummary,
  type TemplateEditorSummary,
} from "@/lib/formBuilder/categoryServerSearchV2";

export type SummaryLoadState = "idle" | "loading" | "success" | "error";

export type UseTemplateEditorSummaryResult = {
  summary: TemplateEditorSummary | null;
  loadState: SummaryLoadState;
  error: string | null;
  refresh: () => void;
};

export function useTemplateEditorSummary(
  organizationId: string | null,
  templateId: string | null,
): UseTemplateEditorSummaryResult {
  const [summary, setSummary] = useState<TemplateEditorSummary | null>(null);
  const [loadState, setLoadState] = useState<SummaryLoadState>("idle");
  const [error, setError] = useState<string | null>(null);
  const generationRef = useRef(0);

  const refresh = useCallback(() => {
    if (!organizationId || !templateId) return;
    const myGeneration = ++generationRef.current;
    setLoadState("loading");
    setError(null);

    getFormTemplateEditorSummary(organizationId, templateId)
      .then((result) => {
        if (myGeneration !== generationRef.current) return;
        setSummary(result);
        setLoadState("success");
      })
      .catch((e: unknown) => {
        if (myGeneration !== generationRef.current) return;
        setLoadState("error");
        setError(e instanceof Error ? e.message : "Summary could not be loaded.");
      });
  }, [organizationId, templateId]);

  useEffect(() => {
    generationRef.current++; // invalidate any in-flight fetch from a previous template
    setSummary(null);
    setLoadState("idle");
    setError(null);
    if (organizationId && templateId) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizationId, templateId]);

  return { summary, loadState, error, refresh };
}
