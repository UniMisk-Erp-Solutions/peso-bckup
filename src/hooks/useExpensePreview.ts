import { useCallback, useEffect, useState } from "react";

interface PreviewState {
  ownerId: string | null;
  open: boolean;
  url: string | null;
  contentType: string | null;
  uploadedBy: string | null;
}

const EMPTY: PreviewState = { ownerId: null, open: false, url: null, contentType: null, uploadedBy: null };

/**
 * Attachment preview state that belongs to ONE expense.
 *
 * `show()` records which expense opened the preview. The returned values are derived: if the expense on
 * screen is no longer that owner, the preview reads as closed with no url, on the same render - an image
 * from expense A can never be displayed while expense B is selected. The stored state is also reset so
 * the preview component releases its object URLs.
 */
export function useExpensePreview(expenseId: string | null) {
  const [state, setState] = useState<PreviewState>(EMPTY);

  const owned = state.ownerId === expenseId;

  useEffect(() => {
    if (state.ownerId !== expenseId && (state.open || state.url)) setState(EMPTY);
  }, [expenseId, state.ownerId, state.open, state.url]);

  const show = useCallback(
    (url: string, contentType: string | null, uploadedBy: string | null) =>
      setState({ ownerId: expenseId, open: true, url, contentType, uploadedBy }),
    [expenseId],
  );
  const setOpen = useCallback((open: boolean) => setState((s) => (open ? s : { ...s, open: false })), []);

  return {
    open: owned && state.open,
    url: owned ? state.url : null,
    contentType: owned ? state.contentType : null,
    uploadedBy: owned ? state.uploadedBy : null,
    show,
    setOpen,
  };
}
