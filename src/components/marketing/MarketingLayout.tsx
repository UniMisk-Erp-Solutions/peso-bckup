import { ReactNode } from "react";
import { HomeNavbar } from "@/components/HomeNavbar";
import { MarketingFooter } from "@/components/marketing/MarketingFooter";

interface MarketingLayoutProps {
  children: ReactNode;
}

/** Lightweight marketing wrapper (e.g. Security page) with shared nav + SEO-friendly footer/NAP */
export function MarketingLayout({ children }: MarketingLayoutProps) {
  return (
    <div className="min-h-screen bg-white flex flex-col">
      <HomeNavbar />
      <main id="main-content" className="min-w-0 flex-1">
        {children}
      </main>
      <MarketingFooter />
    </div>
  );
}
