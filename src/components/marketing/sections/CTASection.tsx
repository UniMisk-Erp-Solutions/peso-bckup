import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { ArrowRight } from "lucide-react";
import { CTA_PRIMARY, CTA_SECONDARY } from "@/lib/marketingCopy";

export function CTASection() {
  return (
    <div className="rounded-2xl border border-border bg-primary/10 p-8 md:p-12 text-center">
      <h2 className="text-2xl font-bold text-foreground mb-4 md:text-3xl">
        Expense management built around the way your business works.
      </h2>
      <p className="text-muted-foreground mb-8 max-w-xl mx-auto">
        Tell us how your process works today. We'll help determine how PesoWise fits around it.
      </p>
      <div className="flex flex-col sm:flex-row gap-4 justify-center">
        <Button asChild size="lg" className="btn-glow group">
          <Link to="/contact">
            {CTA_PRIMARY}
            <ArrowRight className="ml-2 h-4 w-4 transition-transform group-hover:translate-x-1" />
          </Link>
        </Button>
        <Button asChild size="lg" variant="outline">
          <Link to="/how-it-works">{CTA_SECONDARY}</Link>
        </Button>
      </div>
    </div>
  );
}
