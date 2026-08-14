import { ReactNode, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

interface ScrollRevealProps {
  children: ReactNode;
  variant?: "fade-up" | "fade-down" | "fade-left" | "fade-right" | "scale" | "blur";
  delay?: number;
  className?: string;
}

const variantStyles: Record<string, string> = {
  "fade-up": "opacity-0 translate-y-8 data-[visible=true]:opacity-100 data-[visible=true]:translate-y-0",
  "fade-down": "opacity-0 -translate-y-8 data-[visible=true]:opacity-100 data-[visible=true]:translate-y-0",
  "fade-left": "opacity-0 translate-x-8 data-[visible=true]:opacity-100 data-[visible=true]:translate-x-0",
  "fade-right": "opacity-0 -translate-x-8 data-[visible=true]:opacity-100 data-[visible=true]:translate-x-0",
  scale: "opacity-0 scale-95 data-[visible=true]:opacity-100 data-[visible=true]:scale-100",
  blur: "opacity-0 blur-sm data-[visible=true]:opacity-100 data-[visible=true]:blur-0",
};

export function ScrollReveal({ children, variant = "fade-up", delay = 0, className }: ScrollRevealProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) setVisible(true);
      },
      { threshold: 0.1, rootMargin: "0px 0px -40px 0px" }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      data-visible={visible}
      className={cn(
        "transition-all duration-700 ease-out",
        variantStyles[variant] ?? variantStyles["fade-up"],
        className
      )}
      style={{ transitionDelay: `${delay * 100}ms` }}
    >
      {children}
    </div>
  );
}
