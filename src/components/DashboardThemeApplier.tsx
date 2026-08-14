import { useEffect } from "react";
import { useDashboardTheme } from "@/hooks/useDashboardTheme";

/**
 * Applies the active dashboard theme to the whole app by toggling
 * `data-theme="old-money"` on <html> (which re-skins every design-system token in
 * index.css) and loading the serif/sans faces. Renders nothing.
 */
export function DashboardThemeApplier() {
  const [theme] = useDashboardTheme();

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "old-money") {
      root.setAttribute("data-theme", "old-money");
      const id = "om-fonts";
      if (!document.getElementById(id)) {
        const link = document.createElement("link");
        link.id = id;
        link.rel = "stylesheet";
        link.href =
          "https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600;9..144,700&family=Inter:wght@400;500;600;700&display=swap";
        document.head.appendChild(link);
      }
    } else {
      root.removeAttribute("data-theme");
    }
  }, [theme]);

  return null;
}
