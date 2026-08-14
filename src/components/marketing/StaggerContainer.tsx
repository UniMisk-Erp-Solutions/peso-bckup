import { ReactNode, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

interface StaggerContainerProps {
  children: ReactNode;
  className?: string;
}

function StaggerContainerInner({ children, className }: StaggerContainerProps) {
  return <div className={cn(className)}>{children}</div>;
}

export { StaggerContainerInner as StaggerContainer };
export default StaggerContainerInner;

interface StaggerItemProps {
  children: ReactNode;
}

export function StaggerItem({ children }: StaggerItemProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) setVisible(true);
      },
      { threshold: 0.1, rootMargin: "0px 0px -30px 0px" }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className={cn(
        "opacity-0 translate-y-4 transition-all duration-500 ease-out",
        visible && "opacity-100 translate-y-0"
      )}
    >
      {children}
    </div>
  );
}
