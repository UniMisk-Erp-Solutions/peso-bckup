import {
  ClipboardList,
  Wallet,
  Users,
  MapPin,
  BarChart3,
  Rocket,
  LucideIcon,
} from "lucide-react";

const items: { icon: LucideIcon; label: string }[] = [
  { icon: ClipboardList, label: "Ops Teams" },
  { icon: Wallet, label: "Finance" },
  { icon: Users, label: "Admin" },
  { icon: MapPin, label: "Multi-Branch" },
  { icon: BarChart3, label: "SMEs" },
  { icon: Rocket, label: "Startups" },
];

export function LogoWall() {
  return (
    <div className="py-12 border-y border-border">
      <p className="text-sm text-muted-foreground text-center mb-8">
        Trusted by teams across industries
      </p>
      <div className="flex flex-wrap items-center justify-center gap-8 md:gap-12">
        {items.map((item, index) => {
          const Icon = item.icon;
          return (
            <div
              key={index}
              className="flex flex-col items-center gap-2 text-muted-foreground hover:text-foreground transition-colors"
            >
              <Icon className="h-8 w-8 md:h-9 md:w-9" strokeWidth={1.5} />
              <span className="text-sm font-medium">{item.label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
