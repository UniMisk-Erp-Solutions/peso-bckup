import { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface FullBleedBandProps {
  children: ReactNode;
  variant?: "default" | "hero" | "soft" | "transparent" | "white" | "dark";
  className?: string;
}

export function FullBleedBand({ children, variant = "default", className }: FullBleedBandProps) {
  const isHero = variant === "hero";
  const isSoft = variant === "soft";
  const isTransparent = variant === "transparent";
  const isWhite = variant === "white";
  const isDark = variant === "dark";

  return (
    <section
      className={cn(
        "relative w-screen left-1/2 right-1/2 -ml-[50vw] -mr-[50vw] overflow-x-hidden",
        isHero && "bg-gradient-to-br from-primary/5 via-background to-primary/5",
        isSoft && "bg-muted/50",
        isTransparent && "bg-transparent",
        isWhite && "bg-card",
        isDark && "bg-foreground text-background",
        !isHero && !isDark && "py-16",
        className
      )}
    >
      <div className="mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8">
        {children}
      </div>
    </section>
  );
}
