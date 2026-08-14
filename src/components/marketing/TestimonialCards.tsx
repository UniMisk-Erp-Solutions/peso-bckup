import { Card, CardContent } from "@/components/ui/card";
import { Quote } from "lucide-react";

export function TestimonialCards() {
  const testimonials = [
    {
      quote: "PesoWise eliminated our spreadsheet chaos. Approvals are now instant, and we have complete visibility into every expense.",
      author: "Finance Lead",
      role: "Mid-size Manufacturing"
    },
    {
      quote: "The multi-organization support is perfect for our setup. Each location manages expenses independently, but we get unified reporting.",
      author: "Operations Manager",
      role: "Multi-location Retail"
    }
  ];

  return (
    <div className="grid md:grid-cols-2 gap-6">
      {testimonials.map((testimonial, index) => (
        <Card key={index} className="hover:shadow-lg transition-shadow">
          <CardContent className="pt-6">
            <Quote className="h-8 w-8 text-blue-600 mb-4" />
            <p className="text-gray-700 mb-4 italic">"{testimonial.quote}"</p>
            <div>
              <p className="font-semibold text-gray-900">{testimonial.author}</p>
              <p className="text-sm text-gray-600">{testimonial.role}</p>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
