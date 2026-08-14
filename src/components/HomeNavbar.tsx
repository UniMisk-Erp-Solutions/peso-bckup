import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Menu, X } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";

const navLinkClass =
  "text-sm font-medium text-gray-700 hover:text-blue-600 transition-colors py-2 md:py-0";

export function HomeNavbar() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <header className="sticky top-0 z-50 w-full border-b bg-white/95 backdrop-blur supports-[backdrop-filter]:bg-white/80 shadow-sm">
      <nav className="container mx-auto px-4 sm:px-6 lg:px-8" aria-label="Primary">
        <div className="flex h-16 items-center justify-between gap-2 min-w-0">
          <Link
            to="/"
            className="flex flex-shrink-0 items-center gap-2 min-w-0 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2"
          >
            <img
              src="/HERO.png"
              alt="PesoWise"
              width={120}
              height={32}
              decoding="async"
              fetchpriority="high"
              className="h-8 w-auto flex-shrink-0 rounded-lg"
            />
            <span className="text-xl font-bold text-foreground truncate">PesoWise</span>
          </Link>

          <div className="hidden md:flex items-center gap-8">
            <Link to="/" className={navLinkClass}>
              Home
            </Link>
            <Link to="/features" className={navLinkClass}>
              Features
            </Link>
            <Link to="/how-it-works" className={navLinkClass}>
              How It Works
            </Link>
            <Link to="/security" className={navLinkClass}>
              Security
            </Link>
            <Link to="/pricing" className={navLinkClass}>
              Pricing
            </Link>
            <Link to="/contact" className={navLinkClass}>
              Contact
            </Link>
          </div>

          <div className="hidden md:flex items-center gap-3">
            <Button variant="outline" asChild className="text-sm">
              <Link to="/contact">Get Started Free</Link>
            </Button>
            <Button
              asChild
              className="bg-blue-600 hover:bg-blue-700 text-white text-base font-bold px-7 py-2.5 shadow-lg ring-2 ring-blue-600/20"
            >
              <Link to="/auth" aria-label="Login to PesoWise">
                Login
              </Link>
            </Button>
          </div>

          <div className="md:hidden flex flex-shrink-0 items-center gap-1">
            <button
              type="button"
              className="flex h-11 w-11 items-center justify-center rounded-lg text-gray-700 hover:bg-gray-100 active:bg-gray-200 touch-manipulation"
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              aria-label={mobileMenuOpen ? "Close menu" : "Open menu"}
              aria-expanded={mobileMenuOpen}
            >
              {mobileMenuOpen ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
            </button>
            <Button
              asChild
              className="bg-blue-600 hover:bg-blue-700 text-white text-sm font-bold px-4 py-2.5 h-11 touch-manipulation"
            >
              <Link to="/auth" aria-label="Login to PesoWise">
                Login
              </Link>
            </Button>
          </div>
        </div>

        {mobileMenuOpen && (
          <div className="md:hidden border-t bg-white py-2" role="navigation" aria-label="Mobile">
            <div className="flex flex-col">
              {(
                [
                  ["/", "Home"],
                  ["/features", "Features"],
                  ["/how-it-works", "How It Works"],
                  ["/security", "Security"],
                  ["/pricing", "Pricing"],
                  ["/contact", "Contact"],
                ] as const
              ).map(([to, label]) => (
                <Link
                  key={to}
                  to={to}
                  className={cn(
                    "text-left text-sm font-medium text-gray-700 hover:text-blue-600 hover:bg-gray-50 px-4 py-3 min-h-[44px] touch-manipulation"
                  )}
                  onClick={() => setMobileMenuOpen(false)}
                >
                  {label}
                </Link>
              ))}
              <div className="px-4 py-3">
                <Button variant="outline" asChild className="w-full min-h-[44px] touch-manipulation">
                  <Link to="/contact" onClick={() => setMobileMenuOpen(false)}>
                    Get Started Free
                  </Link>
                </Button>
              </div>
            </div>
          </div>
        )}
      </nav>
    </header>
  );
}
