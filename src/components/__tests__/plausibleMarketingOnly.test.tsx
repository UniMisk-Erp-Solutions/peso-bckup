/**
 * Plausible must observe the marketing site and nothing else.
 *
 * The risk this guards is not "the tag fails to load" — it is the opposite. Plausible's
 * current script auto-captures pageviews and follows SPA history changes, so a tag loaded
 * on `/pricing` would keep reporting after the visitor signs in: `/dashboard`, `/review`,
 * `/expenses/<id>`. Lazy injection alone does not prevent that, because the script stays in
 * the document once loaded.
 *
 * So these assert the two things that actually matter: the tag is never injected outside
 * the marketing surface, and a pageview is never dispatched outside it either — including
 * on the navigation *away* from marketing into the app.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider, Outlet } from "react-router-dom";
import { act } from "react";

// The global setup mocks react-router-dom (useNavigate/useParams stubs). This suite drives
// real navigation, so it restores the genuine module for itself only.
vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
}));

import { PlausibleAnalytics } from "@/components/PlausibleAnalytics";
import { MARKETING_ROUTES, isMarketingPath } from "@/lib/marketingRoutes";

const SRC = "https://open-analytics.unimisk.com/js/pa-TLkWZldjgKc3mC178SJ73.js";

function tagCount(): number {
  return document.querySelectorAll(`script[src="${SRC}"]`).length;
}

/** Every event the page dispatched to Plausible. */
function events(): unknown[][] {
  const fn = window.plausible as undefined | { mock?: { calls: unknown[][] } };
  return fn?.mock?.calls ?? [];
}

function renderAt(initial: string) {
  const router = createMemoryRouter(
    [
      {
        path: "/",
        element: (
          <>
            <PlausibleAnalytics />
            <Outlet />
          </>
        ),
        children: [
          { index: true, element: <div>home</div> },
          { path: "pricing", element: <div>pricing</div> },
          { path: "auth", element: <div>auth</div> },
          { path: "dashboard", element: <div>dashboard</div> },
          { path: "review", element: <div>review</div> },
          { path: "legal/data-rights", element: <div>rights</div> },
          { path: "*", element: <div>404</div> },
        ],
      },
    ],
    { initialEntries: [initial] },
  );
  const view = render(<RouterProvider router={router} />);
  return { ...view, router };
}

beforeEach(() => {
  document.querySelectorAll(`script[src="${SRC}"]`).forEach((n) => n.remove());
  // A spy stands in for the real global so dispatches are observable. The component
  // installs its own stub only when it decides to load the tag.
  delete (window as { plausible?: unknown }).plausible;
});

afterEach(() => {
  delete (window as { plausible?: unknown }).plausible;
});

describe("marketing allow-list", () => {
  it.each([...MARKETING_ROUTES])("treats %s as marketing", (path) => {
    expect(isMarketingPath(path)).toBe(true);
  });

  it.each([
    "/auth",
    "/dashboard",
    "/review",
    "/expenses",
    "/expenses/new",
    "/balances",
    "/settings",
    "/admin/expenses",
    "/cash-transfer-history",
    "/notifications",
  ])("treats %s as NOT marketing", (path) => {
    expect(isMarketingPath(path)).toBe(false);
  });

  it("tolerates a trailing slash without matching by prefix", () => {
    expect(isMarketingPath("/pricing/")).toBe(true);
    // The danger of prefix matching: "/" is marketing, so a prefix rule would swallow
    // the entire authenticated application.
    expect(isMarketingPath("/pricingXYZ")).toBe(false);
    expect(isMarketingPath("/features/internal")).toBe(false);
  });

  it("excludes unknown paths, which reach the 404 route", () => {
    expect(isMarketingPath("/dashbord")).toBe(false);
    expect(isMarketingPath("/totally-unknown")).toBe(false);
  });

  it("rejects malformed input rather than throwing", () => {
    expect(isMarketingPath("")).toBe(false);
    expect(isMarketingPath(undefined as unknown as string)).toBe(false);
  });
});

describe("tag injection", () => {
  it("injects the tag on a marketing page", async () => {
    renderAt("/pricing");
    await waitFor(() => expect(tagCount()).toBe(1));
  });

  it.each(["/auth", "/dashboard", "/review"])(
    "never injects the tag on %s",
    async (path) => {
      renderAt(path);
      await new Promise((r) => setTimeout(r, 20));
      expect(tagCount()).toBe(0);
      expect(window.plausible).toBeUndefined();
    },
  );

  it("injects at most once across several marketing navigations", async () => {
    const { router } = renderAt("/");
    await waitFor(() => expect(tagCount()).toBe(1));

    await act(async () => {
      await router.navigate("/pricing");
    });
    await act(async () => {
      await router.navigate("/legal/data-rights");
    });

    expect(tagCount()).toBe(1);
  });

  it("disables auto-capture, so the allow-list is the only source of pageviews", async () => {
    renderAt("/pricing");
    await waitFor(() => expect(window.plausible).toBeTruthy());
    // Without this, the script would follow SPA history into the authenticated app.
    expect(window.plausible?.o).toMatchObject({ autoCapturePageviews: false });
  });
});

describe("pageview dispatch", () => {
  /** Pre-install a spy so every dispatch is captured, including the first. */
  function spyOnPlausible() {
    const fn = vi.fn() as unknown as NonNullable<typeof window.plausible>;
    fn.init = vi.fn((c?: Record<string, unknown>) => {
      fn.o = c || {};
    });
    window.plausible = fn;
    return fn;
  }

  it("sends exactly one pageview per marketing page", async () => {
    spyOnPlausible();
    renderAt("/pricing");
    await waitFor(() => expect(events().length).toBe(1));
    expect(events()[0][0]).toBe("pageview");
  });

  it("sends nothing on the sign-in page", async () => {
    spyOnPlausible();
    renderAt("/auth");
    await new Promise((r) => setTimeout(r, 20));
    expect(events().length).toBe(0);
  });

  it("stops reporting when the visitor moves from marketing into the app", async () => {
    spyOnPlausible();
    const { router } = renderAt("/pricing");
    await waitFor(() => expect(events().length).toBe(1));

    // The exact journey the auto-capture default would have leaked.
    await act(async () => {
      await router.navigate("/auth");
    });
    await act(async () => {
      await router.navigate("/dashboard");
    });
    await act(async () => {
      await router.navigate("/review");
    });

    expect(events().length).toBe(1);
  });

  it("resumes reporting if the visitor returns to marketing", async () => {
    spyOnPlausible();
    const { router } = renderAt("/");
    await waitFor(() => expect(events().length).toBe(1));

    await act(async () => {
      await router.navigate("/dashboard");
    });
    expect(events().length).toBe(1);

    await act(async () => {
      await router.navigate("/pricing");
    });
    await waitFor(() => expect(events().length).toBe(2));
  });

  it("does not send the query string", async () => {
    const fn = spyOnPlausible();
    renderAt("/pricing?utm_source=partner&token=abc");
    await waitFor(() => expect(events().length).toBe(1));
    // Campaign and referral parameters are caller-supplied; they are not forwarded.
    const serialized = JSON.stringify(fn.mock.calls);
    expect(serialized).not.toContain("utm_source");
    expect(serialized).not.toContain("token");
  });

  it("does not double-count when an effect runs twice", async () => {
    spyOnPlausible();
    const { router } = renderAt("/pricing");
    await waitFor(() => expect(events().length).toBe(1));
    // Re-navigating to the same path must not re-report.
    await act(async () => {
      await router.navigate("/pricing");
    });
    expect(events().length).toBe(1);
  });
});
