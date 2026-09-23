import { Outlet, Link, useLocation } from "react-router-dom";
import { useAuth } from "@/app/providers/auth-provider";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetContent, SheetTrigger, SheetTitle } from "@/components/ui/sheet";
import { Menu, LayoutDashboard, Package, Boxes, QrCode, Users, FileText, Settings, LogOut } from "lucide-react";

const navItems = [
  { href: "/admin", label: "Dashboard", icon: LayoutDashboard, exact: true },
  { href: "/admin/skus", label: "SKUs", icon: Package },
  { href: "/admin/batches", label: "Batches", icon: Boxes },
  { href: "/admin/qr-codes", label: "QR Codes", icon: QrCode },
  { href: "/admin/customers", label: "Customers", icon: Users },
  { href: "/admin/audit-log", label: "Audit Log", icon: FileText },
  { href: "/admin/settings", label: "Settings", icon: Settings },
];

interface SidebarNavProps {
  onNavClick?: () => void;
}

function SidebarNav({ onNavClick }: SidebarNavProps) {
  const location = useLocation();

  return (
    <nav className="space-y-1">
      {navItems.map((item) => {
        const isActive = item.exact
          ? location.pathname === item.href
          : location.pathname.startsWith(item.href) && item.href !== "/admin";
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            to={item.href}
            onClick={onNavClick}
            className={cn(
              "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
              isActive
                ? "bg-brand-500 text-white"
                : "text-muted-foreground hover:bg-accent hover:text-foreground"
            )}
          >
            <Icon className="h-4 w-4" />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

export default function AdminLayout() {
  const { user, loading, logout } = useAuth();

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-brand-500 border-t-transparent" />
      </div>
    );
  }

  if (!user || user.role !== "admin") {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <h1 className="text-2xl font-bold mb-2">Access Denied</h1>
          <p className="text-muted-foreground mb-4">You need admin privileges to access this page.</p>
          <Link to="/login">
            <Button>Login as Admin</Button>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen">
      {/* Desktop sidebar */}
      <aside className="hidden lg:flex lg:flex-col lg:w-64 lg:border-r lg:border-border lg:bg-card">
        <div className="flex items-center gap-2 p-4 border-b border-border">
          <Link to="/admin" className="text-lg font-bold">
            Sqanny Admin
          </Link>
        </div>
        <ScrollArea className="flex-1 p-4">
          <SidebarNav />
        </ScrollArea>
        <div className="p-4 border-t border-border">
          <div className="text-sm text-muted-foreground mb-2 truncate">{user.email}</div>
          <Button variant="ghost" size="sm" className="w-full justify-start" onClick={logout}>
            <LogOut className="h-4 w-4 mr-2" />
            Logout
          </Button>
        </div>
      </aside>

      {/* Mobile header */}
      <div className="flex flex-col flex-1">
        <header className="flex items-center gap-4 border-b border-border px-4 h-14 lg:hidden">
          <Sheet>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon">
                <Menu className="h-5 w-5" />
                <span className="sr-only">Toggle menu</span>
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-64 p-0">
              <SheetTitle className="sr-only">Navigation</SheetTitle>
              <div className="flex items-center gap-2 p-4 border-b border-border">
                <Link to="/admin" className="text-lg font-bold">
                  Sqanny Admin
                </Link>
              </div>
              <ScrollArea className="h-[calc(100vh-8rem)] p-4">
                <SidebarNav />
              </ScrollArea>
              <div className="absolute bottom-0 left-0 right-0 p-4 border-t border-border">
                <div className="text-sm text-muted-foreground mb-2 truncate">{user.email}</div>
                <Button variant="ghost" size="sm" className="w-full justify-start" onClick={logout}>
                  <LogOut className="h-4 w-4 mr-2" />
                  Logout
                </Button>
              </div>
            </SheetContent>
          </Sheet>
          <Link to="/admin" className="text-lg font-bold">
            Sqanny Admin
          </Link>
        </header>

        {/* Main content */}
        <main className="flex-1 overflow-auto">
          <div className="p-6">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
