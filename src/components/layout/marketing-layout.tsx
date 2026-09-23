import { Outlet, Link, useLocation } from "react-router-dom";
import { useAuth } from "@/app/providers/auth-provider";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger, SheetTitle } from "@/components/ui/sheet";
import { Menu } from "lucide-react";
import { useState } from "react";

const navItems = [
  { href: "/features", label: "Features" },
  { href: "/pricing", label: "Pricing" },
  { href: "/use-cases", label: "Use Cases" },
  { href: "/docs", label: "Docs" },
];

export default function MarketingLayout() {
  const { user } = useAuth();
  const location = useLocation();
  const [open, setOpen] = useState(false);

  return (
    <div className="min-h-screen flex flex-col">
      <header className="sticky top-0 z-50 border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="max-w-7xl mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <Link to="/" className="text-xl font-bold">
              Sqanny
            </Link>
            {/* Desktop nav */}
            <nav className="hidden md:flex items-center gap-6">
              {navItems.map((item) => (
                <Link
                  key={item.href}
                  to={item.href}
                  className={cn(
                    "text-sm transition-colors hover:text-foreground",
                    location.pathname === item.href
                      ? "text-foreground font-medium"
                      : "text-muted-foreground"
                  )}
                >
                  {item.label}
                </Link>
              ))}
            </nav>
          </div>

          <div className="flex items-center gap-4">
            {/* Desktop auth */}
            <div className="hidden md:flex items-center gap-4">
              {user ? (
                <Link to={user.role === "admin" ? "/admin" : "/customer"}>
                  <Button variant="default" size="sm">Dashboard</Button>
                </Link>
              ) : (
                <>
                  <Link to="/login">
                    <Button variant="ghost" size="sm">Login</Button>
                  </Link>
                  <Link to="/login">
                    <Button size="sm">Get Started</Button>
                  </Link>
                </>
              )}
            </div>

            {/* Mobile menu */}
            <Sheet open={open} onOpenChange={setOpen}>
              <SheetTrigger asChild className="md:hidden">
                <Button variant="ghost" size="icon">
                  <Menu className="h-5 w-5" />
                  <span className="sr-only">Toggle menu</span>
                </Button>
              </SheetTrigger>
              <SheetContent side="right" className="w-72">
                <SheetTitle className="sr-only">Navigation</SheetTitle>
                <nav className="flex flex-col gap-4 mt-8">
                  {navItems.map((item) => (
                    <Link
                      key={item.href}
                      to={item.href}
                      onClick={() => setOpen(false)}
                      className={cn(
                        "text-lg transition-colors hover:text-foreground",
                        location.pathname === item.href
                          ? "text-foreground font-medium"
                          : "text-muted-foreground"
                      )}
                    >
                      {item.label}
                    </Link>
                  ))}
                  <div className="mt-4 pt-4 border-t border-border">
                    {user ? (
                      <Link to={user.role === "admin" ? "/admin" : "/customer"} onClick={() => setOpen(false)}>
                        <Button className="w-full">Dashboard</Button>
                      </Link>
                    ) : (
                      <>
                        <Link to="/login" onClick={() => setOpen(false)}>
                          <Button variant="outline" className="w-full mb-2">Login</Button>
                        </Link>
                        <Link to="/login" onClick={() => setOpen(false)}>
                          <Button className="w-full">Get Started</Button>
                        </Link>
                      </>
                    )}
                  </div>
                </nav>
              </SheetContent>
            </Sheet>
          </div>
        </div>
      </header>

      <main className="flex-1">
        <Outlet />
      </main>

      <footer className="border-t border-border py-8">
        <div className="max-w-7xl mx-auto px-4">
          <div className="grid gap-8 md:grid-cols-4">
            <div>
              <h3 className="font-semibold mb-4">Sqanny</h3>
              <p className="text-sm text-muted-foreground">
                Dynamic QR codes that never break.
              </p>
            </div>
            <div>
              <h4 className="font-medium mb-3">Product</h4>
              <nav className="space-y-2">
                <Link to="/features" className="block text-sm text-muted-foreground hover:text-foreground transition-colors">Features</Link>
                <Link to="/pricing" className="block text-sm text-muted-foreground hover:text-foreground transition-colors">Pricing</Link>
                <Link to="/docs" className="block text-sm text-muted-foreground hover:text-foreground transition-colors">Docs</Link>
              </nav>
            </div>
            <div>
              <h4 className="font-medium mb-3">Company</h4>
              <nav className="space-y-2">
                <Link to="/use-cases" className="block text-sm text-muted-foreground hover:text-foreground transition-colors">Use Cases</Link>
              </nav>
            </div>
            <div>
              <h4 className="font-medium mb-3">Legal</h4>
              <nav className="space-y-2">
                <a href="#" className="block text-sm text-muted-foreground hover:text-foreground transition-colors">Privacy</a>
                <a href="#" className="block text-sm text-muted-foreground hover:text-foreground transition-colors">Terms</a>
              </nav>
            </div>
          </div>
          <div className="mt-8 pt-8 border-t border-border text-center text-sm text-muted-foreground">
            &copy; {new Date().getFullYear()} Sqanny. All rights reserved.
          </div>
        </div>
      </footer>
    </div>
  );
}
