import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { ArrowRight } from "lucide-react";

export function CTASection() {
  return (
    <div className="rounded-2xl border border-border bg-primary/10 p-8 md:p-12 text-center">
      <h2 className="text-2xl font-bold text-foreground mb-4 md:text-3xl">
        Take control of your expenses — without complexity.
      </h2>
      <p className="text-muted-foreground mb-8 max-w-xl mx-auto">
        Join teams who manage expenses with clarity, control, and ERP-friendly workflows.
      </p>
      <div className="flex flex-col sm:flex-row gap-4 justify-center">
        <Button asChild size="lg" className="btn-glow group">
          <Link to="/contact">
            Get Started Free
            <ArrowRight className="ml-2 h-4 w-4 transition-transform group-hover:translate-x-1" />
          </Link>
        </Button>
        <Button asChild size="lg" variant="outline">
          <Link to="/auth">Login</Link>
        </Button>
      </div>
    </div>
  );
}
