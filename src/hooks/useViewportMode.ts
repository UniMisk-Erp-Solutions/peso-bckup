import { useSyncExternalStore } from "react";

const PHONE_QUERY = "(max-width: 767px)";

function getMediaQuery(): MediaQueryList | null {
  if (typeof window === "undefined") return null;
  return window.matchMedia(PHONE_QUERY);
}

function subscribe(cb: () => void): () => void {
  const mql = getMediaQuery();
  if (!mql) return () => {};
  mql.addEventListener("change", cb);
  return () => mql.removeEventListener("change", cb);
}

function getSnapshot(): boolean {
  return getMediaQuery()?.matches ?? false;
}

function getServerSnapshot(): boolean {
  return false;
}

/** Synchronous phone-only gate. Returns true at ≤767px viewport width.
 *  Uses useSyncExternalStore so the value is correct on the first render — no flash. */
export function useViewportMode(): { isMobile: boolean } {
  const isMobile = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return { isMobile };
}
