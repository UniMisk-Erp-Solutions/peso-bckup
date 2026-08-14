import { cn } from "@/lib/utils";

interface ContactIllustrationProps {
  className?: string;
}

export function ContactIllustration({ className }: ContactIllustrationProps) {
  return (
    <svg
      viewBox="0 0 120 100"
      className={cn("flex-shrink-0", className)}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Envelope base */}
      <rect
        x="15"
        y="25"
        width="90"
        height="60"
        rx="6"
        fill="hsl(var(--card))"
        stroke="hsl(var(--border))"
        strokeWidth="2"
      />
      {/* Envelope flap (V-shape) */}
      <path
        d="M15 31l45 28 45-28"
        stroke="hsl(var(--primary))"
        strokeWidth="2"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Lines inside (letter lines) */}
      <rect x="28" y="55" width="35" height="3" rx="1" fill="hsl(var(--muted))" />
      <rect x="28" y="63" width="50" height="3" rx="1" fill="hsl(var(--muted))" />
      <rect x="28" y="71" width="25" height="3" rx="1" fill="hsl(var(--muted))" />
      {/* Paper airplane */}
      <g transform="translate(80, 15) rotate(15)">
        <path d="M0 8L20 0 8 20z" fill="hsl(var(--primary))" />
        <path
          d="M8 20L11 11 20 0"
          stroke="hsl(var(--primary-foreground))"
          strokeWidth="1"
          opacity="0.5"
          fill="none"
        />
      </g>
      {/* Sparkles */}
      <circle cx="100" cy="20" r="2" fill="hsl(var(--accent))" />
      <circle cx="108" cy="28" r="1.5" fill="hsl(var(--warning))" />
      {/* Notification badge */}
      <circle cx="95" cy="35" r="8" fill="hsl(var(--accent))" />
      <text
        x="95"
        y="38"
        textAnchor="middle"
        fontSize="8"
        fill="hsl(var(--accent-foreground))"
        style={{ fontWeight: "bold" }}
      >
        1
      </text>
    </svg>
  );
}
