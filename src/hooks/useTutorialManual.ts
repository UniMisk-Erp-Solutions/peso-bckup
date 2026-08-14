import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { TutorialManual, TutorialRole } from "@/content/tutorialManuals";
import type { OrganizationFeatureKey } from "@/lib/organizationFeatureKeys";

type HelpSectionMeta = {
  title: string;
  paragraphs?: string[];
  requiresFeatures?: string[];
};

type HelpQuickLinkMeta = {
  label: string;
  route?: string;
  requiresFeatures?: string[];
};

function featuresSatisfied(
  requiresFeatures: string[] | undefined,
  hasFeature: (key: OrganizationFeatureKey) => boolean,
): boolean {
  if (!requiresFeatures?.length) return true;
  return requiresFeatures.every((k) => hasFeature(k as OrganizationFeatureKey));
}

export function useTutorialManual(
  role: TutorialRole,
  formattedApprovalLimit: string,
  hasOrganizationFeature: (key: OrganizationFeatureKey) => boolean,
): TutorialManual {
  const { t } = useTranslation("help");

  return useMemo(() => {
    const sectionsRaw = t(`${role}.sections`, { returnObjects: true }) as Record<
      string,
      HelpSectionMeta
    >;
    const quickLinksRaw = t(`${role}.quickLinks`, { returnObjects: true }) as HelpQuickLinkMeta[];

    const sections = Object.entries(sectionsRaw || {})
      .filter(([, section]) => featuresSatisfied(section.requiresFeatures, hasOrganizationFeature))
      .map(([id, section]) => {
        if (role === "engineer" && id === "manager-approval-rules") {
          return {
            id,
            title: section.title,
            paragraphs: [
              t("engineer.dynamicApprovalUnder", { limit: formattedApprovalLimit }),
              t("engineer.dynamicApprovalOver", { limit: formattedApprovalLimit }),
            ],
          };
        }
        return { id, title: section.title, paragraphs: section.paragraphs || [] };
      });

    const quickLinks = (Array.isArray(quickLinksRaw) ? quickLinksRaw : [])
      .filter((link) => featuresSatisfied(link.requiresFeatures, hasOrganizationFeature))
      .map(({ label, route }) => ({ label, route }));

    return {
      role,
      displayName: t(`${role}.displayName`),
      summary: t(`${role}.summary`),
      lastUpdated: t(`${role}.lastUpdated`),
      quickLinks,
      sections,
    };
  }, [role, t, formattedApprovalLimit, hasOrganizationFeature]);
}
