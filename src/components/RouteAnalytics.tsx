import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { initGoogleAnalytics, trackPageView } from "@/lib/analytics";

/**
 * Fires GA4 page views on SPA navigation. Mount once inside <BrowserRouter>.
 */
export function RouteAnalytics() {
  const location = useLocation();

  useEffect(() => {
    initGoogleAnalytics();
  }, []);

  useEffect(() => {
    const path = `${location.pathname}${location.search}`;
    trackPageView(path, document.title);
  }, [location.pathname, location.search]);

  return null;
}
