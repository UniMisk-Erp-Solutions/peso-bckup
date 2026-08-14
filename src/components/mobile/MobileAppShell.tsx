import { useState, useEffect } from "react";
import { useLocation } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { APP_MAIN_SCROLL_ID } from "@/components/ScrollToTop";
import { MobileTopBar } from "./MobileTopBar";
import { MobileBottomNav } from "./MobileBottomNav";
import { MobileMoreSheet } from "./MobileMoreSheet";

type Props = { children: React.ReactNode };

function getInitials(name: string): string {
  return name
    .split(" ")
    .map((w) => w.charAt(0))
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

export function MobileAppShell({ children }: Props) {
  const { userProfile } = useAuth();
  const location = useLocation();
  const [moreOpen, setMoreOpen] = useState(false);

  // Close More sheet whenever the route changes
  useEffect(() => {
    setMoreOpen(false);
  }, [location.pathname]);

  const initials = userProfile?.name ? getInitials(userProfile.name) : "U";

  return (
    <div className="mobile-app-shell">
      <MobileTopBar initials={initials} onAvatarPress={() => setMoreOpen(true)} />

      {/* Single vertical scroll owner — bounded by flex-1 inside the fixed shell */}
      <div id={APP_MAIN_SCROLL_ID} className="mobile-app-scroll">
        {/* pb-8 (32px) provides clearance above the FAB raised portion */}
        <div className="max-w-2xl mx-auto w-full px-4 pt-4 pb-8">
          {children}
        </div>
      </div>

      {/* In-flow nav — shrink-0 prevents flex from squishing it; no position:fixed needed
          because the shell itself is position:fixed covering the full viewport */}
      <MobileBottomNav onMorePress={() => setMoreOpen(true)} />
      <MobileMoreSheet open={moreOpen} onOpenChange={setMoreOpen} />
    </div>
  );
}
