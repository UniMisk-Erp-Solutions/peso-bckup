import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/AuthContext";
import type { TutorialRole } from "@/content/tutorialManuals";
import { Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useTutorialManual } from "@/hooks/useTutorialManual";
import { useTranslation } from "react-i18next";
import { getDateLocale } from "@/lib/formatLocale";
import { ShieldCheck, FileText, Eye, Scale, Cookie, AlertCircle } from "lucide-react";

const LEGAL_LINKS = [
  { icon: ShieldCheck, label: "Privacy Policy", to: "/privacy", description: "How we collect, use, and protect your data" },
  { icon: FileText, label: "Terms & Conditions", to: "/toc", description: "Terms governing your use of PesoWise" },
  { icon: Cookie, label: "Cookie Policy", to: "/cookies", description: "How we use cookies and tracking" },
  { icon: AlertCircle, label: "Disclaimer", to: "/disclaimer", description: "Limitations of liability and warranty" },
  { icon: Eye, label: "Activity Insights Notice", to: "/legal/activity-insights", description: "What is tracked when Activity Insights is enabled" },
  { icon: FileText, label: "Data Processing Policy", to: "/legal/data-processing", description: "How PesoWise processes your organisation's data" },
  { icon: Scale, label: "Data Rights & Grievance", to: "/legal/data-rights", description: "How to request access, correction, deletion, or raise a grievance" },
] as const;

const SUPPORTED_ROLES: TutorialRole[] = [
  "admin",
  "cashier",
  "engineer",
  "employee",
  "team_leader",
  "executive",
];

function resolveTutorialRole(userRole: string | null | undefined): TutorialRole {
  const r = userRole ?? "employee";
  if (r === "team_leader" || r === "executive") return r;
  if (SUPPORTED_ROLES.includes(r as TutorialRole)) return r as TutorialRole;
  return "employee";
}

export default function HelpTutorial() {
  const { userRole, organizationId, hasOrganizationFeature } = useAuth();
  const { t, i18n } = useTranslation("help");
  const [engineerApprovalLimit, setEngineerApprovalLimit] = useState<number>(50000);

  useEffect(() => {
    const loadEngineerApprovalLimit = async () => {
      if (!organizationId) return;
      const { data, error } = await supabase
        .from("organization_settings")
        .select("engineer_approval_limit")
        .eq("organization_id", organizationId)
        .maybeSingle();
      if (!error && data?.engineer_approval_limit !== null && data?.engineer_approval_limit !== undefined) {
        const limit = Number(data.engineer_approval_limit);
        if (Number.isFinite(limit) && limit > 0) {
          setEngineerApprovalLimit(limit);
        } else {
          setEngineerApprovalLimit(Number.POSITIVE_INFINITY);
        }
      } else if (!error) {
        setEngineerApprovalLimit(Number.POSITIVE_INFINITY);
      }
    };
    void loadEngineerApprovalLimit();
  }, [organizationId]);

  const role = resolveTutorialRole(userRole);
  const formattedApprovalLimit = useMemo(
    () =>
      Number.isFinite(engineerApprovalLimit)
        ? new Intl.NumberFormat(getDateLocale(i18n.language)).format(engineerApprovalLimit)
        : "No limit",
    [engineerApprovalLimit, i18n.language],
  );

  const manual = useTutorialManual(role, formattedApprovalLimit, hasOrganizationFeature);

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6">
      <Card className="border-0 shadow-xl bg-white">
        <CardHeader className="bg-gradient-to-r from-indigo-600 to-blue-600 text-white rounded-t-lg">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle className="text-2xl md:text-3xl">{manual.displayName}</CardTitle>
              <CardDescription className="text-indigo-100 mt-2 text-sm md:text-base">
                {manual.summary}
              </CardDescription>
            </div>
            <Badge variant="secondary" className="bg-white/20 text-white border-transparent">
              {t("ui.lastUpdated", { date: manual.lastUpdated })}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4 p-5 md:p-6">
          <div>
            <h3 className="text-sm font-semibold text-gray-700 mb-2 uppercase tracking-wide">
              {t("ui.quickLinks")}
            </h3>
            <div className="flex flex-wrap gap-2">
              {manual.quickLinks.map((item) =>
                item.route ? (
                  <Button key={item.label} asChild variant="outline" size="sm">
                    <Link to={item.route}>{item.label}</Link>
                  </Button>
                ) : (
                  <Badge key={item.label} variant="outline">
                    {item.label}
                  </Badge>
                ),
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 md:gap-5">
        {manual.sections.map((section, sectionIndex) => (
          <Card key={section.id} className="shadow-sm border bg-white">
            <CardHeader className="pb-2 pt-4 md:pt-5">
              <div className="flex items-center gap-3">
                <Badge variant="outline" className="font-semibold">
                  {sectionIndex + 1}
                </Badge>
                <CardTitle className="text-base md:text-lg leading-6">{section.title}</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="pb-4 md:pb-5">
              <ul className="space-y-2 md:space-y-3">
                {section.paragraphs.map((paragraph, idx) => (
                  <li key={`${section.id}-${idx}`} className="flex items-start gap-2.5 text-gray-700">
                    <span className="mt-2 h-1.5 w-1.5 rounded-full bg-indigo-500 flex-shrink-0" />
                    <p className="text-sm md:text-[15px] leading-6">{paragraph}</p>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Legal & Privacy */}
      <Card className="shadow-sm border bg-white">
        <CardHeader className="pb-2 pt-4 md:pt-5">
          <div className="flex items-center gap-3">
            <ShieldCheck className="h-5 w-5 text-indigo-500 shrink-0" />
            <CardTitle className="text-base md:text-lg leading-6">Legal &amp; Privacy</CardTitle>
          </div>
          <CardDescription className="text-sm text-gray-500 mt-1">
            Your rights, our policies, and how your data is handled on PesoWise.
          </CardDescription>
        </CardHeader>
        <CardContent className="pb-4 md:pb-5">
          <div className="grid gap-2 sm:grid-cols-2">
            {LEGAL_LINKS.map(({ icon: Icon, label, to, description }) => (
              <Link
                key={to}
                to={to}
                className="flex items-start gap-3 rounded-lg border border-gray-100 bg-gray-50 p-3 text-sm hover:border-indigo-200 hover:bg-indigo-50 transition-colors"
              >
                <Icon className="h-4 w-4 text-indigo-500 mt-0.5 shrink-0" />
                <div>
                  <p className="font-medium text-gray-800">{label}</p>
                  <p className="text-xs text-gray-500 mt-0.5">{description}</p>
                </div>
              </Link>
            ))}
          </div>
          <p className="mt-3 text-xs text-gray-400">
            These pages are publicly accessible. Links open in a new tab.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
