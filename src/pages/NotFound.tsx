import { Link, useLocation } from "react-router-dom";
import { useEffect } from "react";
import { Helmet } from "react-helmet-async";
import { MarketingShell, FullBleedBand } from "@/components/marketing";
import { Button } from "@/components/ui/button";

/**
 * Client-side 404. SPA hosts typically still return HTTP 200 for unknown paths
 * (see hosting notes in project docs / README). This page sets noindex and clear UX.
 */
const NotFound = () => {
  const location = useLocation();

  useEffect(() => {
    console.error("404: non-existent route:", location.pathname);
  }, [location.pathname]);

  return (
    <MarketingShell>
      <Helmet>
        <title>Page not found | PesoWise</title>
        <meta name="description" content="The page you requested could not be found." />
        <meta name="robots" content="noindex, nofollow" />
      </Helmet>
      <FullBleedBand className="py-24">
        <div className="mx-auto max-w-lg text-center space-y-6">
          <h1 className="text-4xl font-bold text-foreground">Page not found</h1>
          <p className="text-muted-foreground">
            We could not find <span className="font-mono text-sm">{location.pathname}</span>.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Button asChild>
              <Link to="/">Back to home</Link>
            </Button>
            <Button asChild variant="outline">
              <Link to="/contact">Contact support</Link>
            </Button>
          </div>
        </div>
      </FullBleedBand>
    </MarketingShell>
  );
};

export default NotFound;
