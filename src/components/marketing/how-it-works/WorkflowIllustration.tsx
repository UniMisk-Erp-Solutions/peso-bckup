import { cn } from "@/lib/utils";

interface WorkflowIllustrationProps {
  className?: string;
}

export function WorkflowIllustration({ className }: WorkflowIllustrationProps) {
  return (
    <svg
      viewBox="0 0 200 140"
      className={cn("flex-shrink-0", className)}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Step 1 – Submit (left) */}
      <circle cx="30" cy="55" r="20" fill="hsl(var(--primary))" fillOpacity="0.1" />
      <circle cx="30" cy="55" r="14" fill="hsl(var(--primary))" />
      <path
        d="M25 55l9-7v14l-9-7z"
        fill="hsl(var(--primary-foreground))"
      />
      {/* Arrow 1 */}
      <path d="M52 55h18" stroke="hsl(var(--border))" strokeWidth="2" strokeDasharray="4 2" />
      <path d="M68 51l6 4-6 4" stroke="hsl(var(--primary))" strokeWidth="2" strokeLinecap="round" fill="none" />
      {/* Step 2 – Review (center) */}
      <circle cx="90" cy="55" r="20" fill="hsl(var(--warning))" fillOpacity="0.1" />
      <circle cx="90" cy="55" r="14" fill="hsl(var(--warning))" />
      <path d="M85 51h10" stroke="hsl(var(--warning-foreground))" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M85 55h10" stroke="hsl(var(--warning-foreground))" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M85 59h7" stroke="hsl(var(--warning-foreground))" strokeWidth="1.5" strokeLinecap="round" />
      {/* Arrow 2 */}
      <path d="M112 55h18" stroke="hsl(var(--border))" strokeWidth="2" strokeDasharray="4 2" />
      <path d="M128 51l6 4-6 4" stroke="hsl(var(--warning))" strokeWidth="2" strokeLinecap="round" fill="none" />
      {/* Step 3 – Approve (right) */}
      <circle cx="150" cy="55" r="20" fill="hsl(var(--accent))" fillOpacity="0.1" />
      <circle cx="150" cy="55" r="14" fill="hsl(var(--accent))" />
      <path
        d="M144 55l4 4 8-8"
        stroke="hsl(var(--accent-foreground))"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      {/* Arrow 3 */}
      <path d="M172 55h10" stroke="hsl(var(--border))" strokeWidth="2" strokeDasharray="4 2" />
      <path d="M180 51l6 4-6 4" stroke="hsl(var(--accent))" strokeWidth="2" strokeLinecap="round" fill="none" />
      {/* Labels – larger and lower for legibility */}
      <text x="30" y="105" textAnchor="middle" fontSize="14" fontWeight="500" fill="hsl(var(--foreground))">
        Submit
      </text>
      <text x="90" y="105" textAnchor="middle" fontSize="14" fontWeight="500" fill="hsl(var(--foreground))">
        Review
      </text>
      <text x="150" y="105" textAnchor="middle" fontSize="14" fontWeight="500" fill="hsl(var(--foreground))">
        Approve
      </text>
    </svg>
  );
}
