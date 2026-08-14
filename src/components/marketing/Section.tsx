import { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface SectionProps {
  children: ReactNode;
  className?: string;
  variant?: "default" | "band";
}

export function Section({ children, className, variant = "default" }: SectionProps) {
  if (variant === "band") {
    return (
      <section className={cn("w-full bg-gray-50", className)}>
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-16">
          {children}
        </div>
      </section>
    );
  }

  return (
    <section className={cn("w-full", className)}>
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-16">
        {children}
      </div>
    </section>
  );
}

export function SectionBand({ children, className }: { children: ReactNode; className?: string }) {
  return <Section variant="band" className={className}>{children}</Section>;
}
