import { cn } from "@/lib/utils";

interface ReceiptIllustrationProps {
  className?: string;
}

export function ReceiptIllustration({ className }: ReceiptIllustrationProps) {
  return (
    <svg
      viewBox="0 0 120 140"
      className={cn("flex-shrink-0", className)}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Receipt shape: rounded paper */}
      <rect
        x="12"
        y="8"
        width="96"
        height="120"
        rx="4"
        fill="hsl(var(--card))"
        stroke="hsl(var(--border))"
        strokeWidth="2"
      />
      {/* Header bar */}
      <rect x="35" y="22" width="50" height="6" rx="2" fill="hsl(var(--primary))" />
      {/* Date line */}
      <rect x="40" y="34" width="40" height="3" rx="1" fill="hsl(var(--muted))" />
      {/* Divider dashed */}
      <line x1="20" y1="46" x2="100" y2="46" stroke="hsl(var(--border))" strokeWidth="1" strokeDasharray="4 2" />
      {/* Line items */}
      <rect x="24" y="54" width="42" height="3" rx="1" fill="hsl(var(--muted-foreground) / 0.6)" />
      <rect x="82" y="54" width="14" height="3" rx="1" fill="hsl(var(--muted-foreground) / 0.6)" />
      <rect x="24" y="64" width="38" height="3" rx="1" fill="hsl(var(--muted-foreground) / 0.6)" />
      <rect x="82" y="64" width="14" height="3" rx="1" fill="hsl(var(--muted-foreground) / 0.6)" />
      <rect x="24" y="74" width="35" height="3" rx="1" fill="hsl(var(--muted-foreground) / 0.6)" />
      <rect x="82" y="74" width="14" height="3" rx="1" fill="hsl(var(--muted-foreground) / 0.6)" />
      {/* Second divider */}
      <line x1="20" y1="86" x2="100" y2="86" stroke="hsl(var(--border))" strokeWidth="1" strokeDasharray="4 2" />
      {/* Total row */}
      <rect x="24" y="94" width="24" height="4" rx="1" fill="hsl(var(--foreground))" />
      <rect x="78" y="94" width="18" height="4" rx="1" fill="hsl(var(--accent))" />
      {/* Checkmark badge */}
      <circle cx="96" cy="20" r="12" fill="hsl(var(--accent))" />
      <path
        d="M91 20l3 3 6-6"
        stroke="hsl(var(--accent-foreground))"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}
