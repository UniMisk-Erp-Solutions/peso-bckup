import * as React from "react";

/**
 * Compact layout: phones, iPad portrait/landscape, and other touch tablets.
 * iPad Safari is often >= 768px wide, so width-only breakpoints leave a cramped desktop sidebar.
 */
export const COMPACT_LAYOUT_MEDIA_QUERY =
  "(max-width: 1023px), ((max-width: 1400px) and (pointer: coarse))";

/** @deprecated Prefer name `useIsCompactLayout`; kept for shadcn sidebar compatibility. */
export function useIsMobile() {
  return useIsCompactLayout();
}

export function useIsCompactLayout() {
  const [isCompact, setIsCompact] = React.useState<boolean | undefined>(undefined);

  React.useEffect(() => {
    const mql = window.matchMedia(COMPACT_LAYOUT_MEDIA_QUERY);
    const onChange = () => setIsCompact(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return !!isCompact;
}
