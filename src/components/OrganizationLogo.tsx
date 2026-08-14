import { useEffect, useState } from "react";

export const DEFAULT_ORG_LOGO = "/HERO.png";

type OrganizationLogoProps = {
  logoUrl?: string | null;
  alt?: string;
  className?: string;
  /** When true, skips org URL and always shows the default PesoWise mark. */
  forceDefault?: boolean;
};

export function OrganizationLogo({
  logoUrl,
  alt = "Organization",
  className,
  forceDefault = false,
}: OrganizationLogoProps) {
  const [useFallback, setUseFallback] = useState(false);

  useEffect(() => {
    setUseFallback(false);
  }, [logoUrl]);

  const trimmed = logoUrl?.trim();
  const src =
    forceDefault || useFallback || !trimmed ? DEFAULT_ORG_LOGO : trimmed;

  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      decoding="async"
      className={className}
      onError={() => setUseFallback(true)}
    />
  );
}
