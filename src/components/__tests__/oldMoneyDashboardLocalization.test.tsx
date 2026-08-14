/**
 * DOC-087 — Old Money dashboard localization.
 *
 * This theme shipped with every user-facing string hard-coded in English. It is
 * now fully translated (EN/HI/GU), with dates and currency following the app
 * language too. These tests render the component against real locale JSON so a
 * missing key shows up as a failure rather than a raw key in the UI.
 */
import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { readFileSync } from "fs";
import { resolve } from "path";
import { OldMoneyDashboard } from "../dashboard/OldMoneyDashboard";
import { useAuth } from "@/contexts/AuthContext";

const language = { current: "en" };

// Resolve against the real dashboard namespace for whichever language is active.
vi.mock("react-i18next", async () => {
  const load = (lang: string) =>
    JSON.parse(
      readFileSync(
        resolve(process.cwd(), `src/locales/${lang}/dashboard.json`),
        "utf-8",
      ),
    ) as Record<string, unknown>;
  const bundles: Record<string, Record<string, unknown>> = {
    en: load("en"),
    hi: load("hi"),
    gu: load("gu"),
  };
  return {
    useTranslation: () => ({
      t: (key: string, opts?: Record<string, unknown>) => {
        let val: unknown = bundles[language.current];
        for (const part of key.split(".")) {
          if (val == null || typeof val !== "object") return key;
          val = (val as Record<string, unknown>)[part];
        }
        if (typeof val !== "string") return key;
        return opts
          ? val.replace(/\{\{(\w+)\}\}/g, (_, k) => String(opts[k] ?? `{{${k}}}`))
          : val;
      },
      i18n: { language: language.current, changeLanguage: vi.fn() },
    }),
    initReactI18next: { type: "3rdParty", init: vi.fn() },
  };
});

// date-fns is globally stubbed in setup.ts; keep a real-ish format so the
// component's locale-aware calls are exercised rather than short-circuited.
vi.mock("date-fns", () => ({
  format: (date: Date, pattern: string, opts?: { locale?: unknown }) => {
    expect(opts?.locale, "format() must receive the app's date-fns locale").toBeDefined();
    return pattern === "MMM" ? "Aug" : "August 2026";
  },
}));

const DATA = {
  monthSpent: 4000,
  monthApproved: 3000,
  monthPending: 1000,
  monthCount: 4,
  categories: [{ name: "travel", amount: 4000 }],
  months: [{ label: "Aug", submitted: 4000, approved: 3000 }],
  recent: [] as unknown[],
  lastDebitAt: null,
  employeeId: null,
  deltaPct: 12.5,
  monthLargest: 2500,
};

vi.mock("@/hooks/useOldMoneyDashboardData", () => ({
  useOldMoneyDashboardData: () => DATA,
}));

function mockAuth() {
  vi.mocked(useAuth).mockReturnValue({
    user: { id: "emp-1", email: "emp@example.com" },
    userProfile: { name: "Asha Patel" },
    userRole: "employee",
    organizationId: "org-1",
    hasOrganizationFeature: () => false,
  } as unknown as ReturnType<typeof useAuth>);
}

const renderIn = (lang: string) => {
  language.current = lang;
  return render(
    <MemoryRouter>
      <OldMoneyDashboard currentBalance={18250} />
    </MemoryRouter>,
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth();
  language.current = "en";
});

describe("Old Money dashboard — English", () => {
  it("renders the localized panel headings", () => {
    renderIn("en");
    expect(screen.getByText("Net Position")).toBeInTheDocument();
    expect(screen.getByText("Monthly Spend")).toBeInTheDocument();
    expect(screen.getByText("Recent activity")).toBeInTheDocument();
  });

  it("interpolates amounts into the legend", () => {
    renderIn("en");
    expect(screen.getByText(/Approved ₹3,000\.00/)).toBeInTheDocument();
    expect(screen.getByText(/Pending ₹1,000\.00/)).toBeInTheDocument();
  });

  it("interpolates the month-over-month delta", () => {
    renderIn("en");
    expect(screen.getByText(/12\.5% spend vs last month/)).toBeInTheDocument();
  });

  it("localizes the chart aria-label", () => {
    renderIn("en");
    expect(screen.getByLabelText("Submitted vs approved by month")).toBeInTheDocument();
  });
});

describe.each([
  ["hi", "शुद्ध स्थिति", "मासिक खर्च", "हाल की गतिविधि"],
  ["gu", "ચોખ્ખી સ્થિતિ", "માસિક ખર્ચ", "તાજેતરની પ્રવૃત્તિ"],
])("Old Money dashboard — %s", (lang, netPosition, monthlySpend, recentActivity) => {
  it("renders translated headings, not English", () => {
    renderIn(lang);
    expect(screen.getByText(netPosition)).toBeInTheDocument();
    expect(screen.getByText(monthlySpend)).toBeInTheDocument();
    expect(screen.getByText(recentActivity)).toBeInTheDocument();

    expect(screen.queryByText("Net Position")).not.toBeInTheDocument();
    expect(screen.queryByText("Monthly Spend")).not.toBeInTheDocument();
    expect(screen.queryByText("Recent activity")).not.toBeInTheDocument();
  });

  it("renders no raw translation keys", () => {
    const { container } = renderIn(lang);
    expect(container.textContent).not.toContain("oldMoney.");
  });
});

describe("Old Money dashboard — source hygiene", () => {
  const rawSource = readFileSync(
    resolve(process.cwd(), "src/components/dashboard/OldMoneyDashboard.tsx"),
    "utf-8",
  );
  // Comments may still name a panel ("LEFT — Net Position"); only shipped copy
  // matters here, so strip block and line comments before scanning.
  const source = rawSource
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

  it.each([
    "Good morning",
    "Good afternoon",
    "Good evening",
    "Here is where your money stands today.",
    "Net Position",
    "Available balance",
    "Monthly Spend",
    "Where it went",
    "Recent activity",
    "No recent activity.",
    "No spending recorded this month.",
    "Last debit",
    "Approved rate",
    "Avg expense",
    "spend vs last month",
    "Submitted vs approved by month",
  ])("no longer hard-codes %j", (phrase) => {
    expect(source).not.toContain(`${phrase}`);
  });

  it("keeps VISA as an untranslated card-face brand mark", () => {
    // Deliberate: a brand mark printed on the card graphic, not UI copy.
    expect(source).toContain(">VISA<");
  });

  it("routes currency and dates through the locale helpers", () => {
    expect(source).toContain("getDateFnsLocale(i18n.language)");
    expect(source).toContain("getDateLocale(i18n.language)");
    // No bare formatINR(x) calls left that would ignore the app language.
    expect(source).not.toMatch(/formatINR\((?!amount, moneyLocale)/);
  });
});
