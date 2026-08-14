import { Card, CardContent } from "@/components/ui/card";
import { Quote } from "lucide-react";
import { TESTIMONIALS } from "@/lib/marketingCopy";

export function Testimonials() {
  return (
    <div className="space-y-12">
      <h2 className="text-2xl font-bold text-foreground text-center md:text-3xl mb-8">
        What teams are saying
      </h2>
      <div className="grid md:grid-cols-2 gap-6">
        {TESTIMONIALS.map((t, i) => (
          <Card key={i} className="shadow-soft card-hover border-border bg-card">
            <CardContent className="pt-6">
              <Quote className="h-8 w-8 text-primary mb-4" />
              <p className="text-muted-foreground mb-4 italic">&quot;{t.quote}&quot;</p>
              <p className="font-semibold text-foreground">{t.author}</p>
              <p className="text-sm text-muted-foreground">{t.role}</p>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
