import { useEffect, useState } from "react";
import {
  getDashboardTheme,
  setDashboardTheme,
  subscribeDashboardTheme,
  type DashboardTheme,
} from "@/lib/dashboardTheme";

/** Reactive access to the current dashboard theme + a setter. */
export function useDashboardTheme(): [DashboardTheme, (t: DashboardTheme) => void] {
  const [theme, setTheme] = useState<DashboardTheme>(() => getDashboardTheme());

  useEffect(() => subscribeDashboardTheme(setTheme), []);

  return [theme, setDashboardTheme];
}
