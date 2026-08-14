import { useLocation, useNavigate } from "react-router-dom";
import { Bell, ChevronLeft } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { getPageTitle } from "@/lib/pageTitle";

type Props = {
  initials: string;
  onAvatarPress: () => void;
};

function getBackTarget(pathname: string, search: string): string | null {
  if (pathname === "/expenses/new") return "/expenses";
  if (pathname === "/expenses/batch/new") return "/expenses";
  if (/^\/expenses\/[^/]+\/edit$/.test(pathname)) {
    const id = pathname.split("/")[2];
    return `/expenses/${id}`;
  }
  if (/^\/expenses\/batch\/[^/]+\/review$/.test(pathname)) {
    const params = new URLSearchParams(search);
    const from = params.get("from");
    if (from === "review") return "/review";
    if (from === "admin") return "/admin/expenses";
    return "/expenses";
  }
  if (/^\/expenses\/[^/]+$/.test(pathname)) return "/expenses";
  return null;
}

export function MobileTopBar({ initials, onAvatarPress }: Props) {
  const location = useLocation();
  const navigate = useNavigate();
  const backTarget = getBackTarget(location.pathname, location.search);
  const title = getPageTitle(location.pathname);

  return (
    <header className="shrink-0 flex flex-col bg-background/90 backdrop-blur-md border-b border-border z-40 pt-safe">
      <div className="h-14 flex items-center gap-1 px-3">
        {backTarget ? (
          <button
            onClick={() => navigate(backTarget)}
            className="touch-target flex items-center justify-center rounded-lg text-foreground hover:bg-muted transition-colors"
            aria-label="Go back"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
        ) : (
          <div className="w-10" aria-hidden />
        )}

        <span className="flex-1 text-center text-sm font-semibold text-foreground truncate px-2">
          {title}
        </span>

        <div className="flex items-center gap-0.5">
          <button
            onClick={() => navigate("/notifications")}
            className="touch-target flex items-center justify-center rounded-lg text-foreground hover:bg-muted transition-colors"
            aria-label="Notifications"
          >
            <Bell className="h-5 w-5" />
          </button>
          <button
            onClick={onAvatarPress}
            className="touch-target flex items-center justify-center"
            aria-label="Open menu"
          >
            <Avatar className="h-8 w-8">
              <AvatarFallback className="bg-primary text-primary-foreground text-xs font-semibold">
                {initials}
              </AvatarFallback>
            </Avatar>
          </button>
        </div>
      </div>
    </header>
  );
}
