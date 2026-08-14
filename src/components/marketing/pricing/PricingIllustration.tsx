import { cn } from "@/lib/utils";

interface PricingIllustrationProps {
  className?: string;
}

export function PricingIllustration({ className }: PricingIllustrationProps) {
  return (
    <svg
      viewBox="0 0 140 100"
      className={cn("flex-shrink-0", className)}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Background bars (left to right) */}
      <rect x="10" y="70" width="25" height="20" rx="4" fill="hsl(var(--muted))" />
      <rect x="45" y="50" width="25" height="40" rx="4" fill="hsl(var(--primary))" fillOpacity="0.2" />
      <rect x="80" y="30" width="25" height="60" rx="4" fill="hsl(var(--primary))" fillOpacity="0.3" />
      {/* Highlight bar (popular tier) */}
      <rect x="45" y="45" width="25" height="45" rx="4" fill="hsl(var(--primary))" />
      <text x="57.5" y="65" textAnchor="middle" fontSize="8" fill="hsl(var(--primary-foreground))" style={{ fontWeight: "bold" }}>
        PRO
      </text>
      {/* Stars on popular bar */}
      <circle cx="55" cy="38" r="2" fill="hsl(var(--warning))" />
      <circle cx="65" cy="42" r="1.5" fill="hsl(var(--warning))" />
      {/* Price tag (top right) */}
      <rect x="115" y="20" width="20" height="14" rx="3" fill="hsl(var(--accent))" />
      <text x="125" y="30" textAnchor="middle" fontSize="7" fill="hsl(var(--accent-foreground))">
        ₹
      </text>
      {/* Large coin */}
      <circle cx="125" cy="55" r="10" fill="hsl(var(--warning))" fillOpacity="0.3" />
      <circle cx="125" cy="55" r="7" fill="hsl(var(--warning))" />
      <text x="125" y="58" textAnchor="middle" fontSize="8" fill="hsl(var(--warning-foreground))" style={{ fontWeight: "bold" }}>
        ₹
      </text>
      {/* Small coin */}
      <circle cx="118" cy="70" r="8" fill="hsl(var(--warning))" fillOpacity="0.3" />
      <circle cx="118" cy="70" r="5" fill="hsl(var(--warning))" />
    </svg>
  );
}
