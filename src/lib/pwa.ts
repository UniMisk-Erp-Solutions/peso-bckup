import { buildWebManifest, defaultManifestForHost, PWA_INSTALL_ICONS } from "@/lib/pwaManifest";

const PWA_DISMISS_KEY = "pesowise_pwa_install_dismissed";
const MANIFEST_LINK_ID = "pesowise-manifest-link";

export function isStandaloneDisplayMode(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export function wasPwaInstallDismissed(): boolean {
  try {
    return localStorage.getItem(PWA_DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

export function dismissPwaInstallPrompt(): void {
  try {
    localStorage.setItem(PWA_DISMISS_KEY, "1");
  } catch {
    /* ignore */
  }
}

export function clearPwaInstallDismissed(): void {
  try {
    localStorage.removeItem(PWA_DISMISS_KEY);
  } catch {
    /* ignore */
  }
}

/** Phone / tablet style devices (touch-first install prompt). */
export function isMobileDevice(): boolean {
  if (typeof window === "undefined") return false;
  const ua = navigator.userAgent || "";
  const mobileUa = /Android|iPhone|iPad|iPod|Mobile|webOS|BlackBerry|IEMobile|Opera Mini/i.test(
    ua,
  );
  const narrowTouch =
    window.matchMedia("(max-width: 768px)").matches &&
    window.matchMedia("(pointer: coarse)").matches;
  return mobileUa || narrowTouch;
}

export function isIosDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  const platform = navigator.platform || "";
  return (
    /iPad|iPhone|iPod/.test(ua) ||
    (platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

/** Production: Vercel API. Dev: blob URL from host + optional org. */
export function applyManifestLink(
  hostname: string,
  org?: { name: string; logo_url?: string | null } | null,
): void {
  if (typeof document === "undefined") return;

  let link = document.getElementById(MANIFEST_LINK_ID) as HTMLLinkElement | null;
  if (!link) {
    link = document.createElement("link");
    link.id = MANIFEST_LINK_ID;
    link.rel = "manifest";
    document.head.appendChild(link);
  }

  const prev = link.getAttribute("data-blob-url");
  if (prev?.startsWith("blob:")) {
    try {
      URL.revokeObjectURL(prev);
    } catch {
      /* ignore */
    }
  }

  if (import.meta.env.PROD) {
    const manifestKey = `${hostname}:${org?.name ?? ""}:${org?.logo_url ?? ""}`;
    if (link.getAttribute("data-manifest-key") !== manifestKey) {
      link.href = "/site.webmanifest";
      link.setAttribute("data-manifest-key", manifestKey);
    }
    link.removeAttribute("data-blob-url");
    return;
  }

  const manifest = defaultManifestForHost(hostname, org);
  const blob = new Blob([JSON.stringify(manifest, null, 2)], {
    type: "application/manifest+json",
  });
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.setAttribute("data-blob-url", url);
}

export function applyPwaMetaTags(options: {
  title?: string;
  themeColor?: string;
  iconUrl?: string | null;
}): void {
  if (typeof document === "undefined") return;

  const setMeta = (name: string, content: string) => {
    let el = document.querySelector(`meta[name="${name}"]`) as HTMLMetaElement | null;
    if (!el) {
      el = document.createElement("meta");
      el.setAttribute("name", name);
      document.head.appendChild(el);
    }
    el.setAttribute("content", content);
  };

  if (options.title) {
    setMeta("application-name", options.title);
    setMeta("apple-mobile-web-app-title", options.title);
  }
  if (options.themeColor) {
    setMeta("theme-color", options.themeColor);
  }

  const icon = options.iconUrl?.trim() || PWA_INSTALL_ICONS.icon192;
  const href = icon.startsWith("http") ? icon : icon.startsWith("/") ? icon : `/${icon}`;

  for (const rel of ["apple-touch-icon", "icon"]) {
    let link = document.querySelector(`link[rel="${rel}"]`) as HTMLLinkElement | null;
    if (!link) {
      link = document.createElement("link");
      link.rel = rel;
      document.head.appendChild(link);
    }
    link.href = href;
  }
}

export { buildWebManifest, defaultManifestForHost };
