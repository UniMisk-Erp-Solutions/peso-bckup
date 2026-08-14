import { useEffect } from "react";
import { useLocation } from "react-router-dom";

export const APP_MAIN_SCROLL_ID = "app-main-scroll";

/**
 * Scrolls the app main panel (and window) to the top when the route changes.
 * Layout uses #app-main-scroll as the primary scroll container on phone/PWA.
 */
export function ScrollToTop() {
  const { pathname } = useLocation();

  useEffect(() => {
    const main = document.getElementById(APP_MAIN_SCROLL_ID);
    main?.scrollTo(0, 0);
    window.scrollTo(0, 0);
  }, [pathname]);

  return null;
}
