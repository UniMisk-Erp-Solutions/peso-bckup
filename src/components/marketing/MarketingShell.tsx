import { ReactNode } from "react";
import { HomeNavbar } from "@/components/HomeNavbar";
import { MarketingFooter } from "@/components/marketing/MarketingFooter";
import { CookieConsentProvider } from "@/components/legal/CookieConsentBanner";

interface MarketingShellProps {
  children: ReactNode;
}

export function MarketingShell({ children }: MarketingShellProps) {
  return (
    <CookieConsentProvider>
      <div className="min-h-app w-full max-w-[100vw] overflow-x-clip bg-background">
        {/* Full viewport background: light dot/gradient vibe */}
        <div className="fixed inset-0 -z-10 overflow-hidden pointer-events-none">
          <div className="absolute inset-0 bg-gradient-to-br from-primary/5 via-background to-primary/5" />
          <svg className="absolute inset-0 w-full h-full opacity-30" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <pattern id="marketing-dots" width="40" height="40" patternUnits="userSpaceOnUse">
                <circle cx="20" cy="20" r="1" fill="currentColor" className="text-primary/20" />
              </pattern>
            </defs>
            <rect width="100%" height="100%" fill="url(#marketing-dots)" />
          </svg>
          <div className="absolute top-0 right-0 w-[50vw] max-w-[600px] h-[600px] bg-gradient-to-bl from-primary/10 to-transparent rounded-full blur-3xl" />
          <div className="absolute bottom-0 left-0 w-[50vw] max-w-[600px] h-[600px] bg-gradient-to-tr from-primary/10 to-transparent rounded-full blur-3xl" />
        </div>
        <HomeNavbar />
        <main id="main-content" className="min-w-0">
          {children}
        </main>
        <MarketingFooter />
      </div>
    </CookieConsentProvider>
  );
}
