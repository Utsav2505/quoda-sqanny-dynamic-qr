import type { FC, PropsWithChildren } from "hono/jsx";
import { raw } from "hono/html";
import { Layout } from "./layout";
import type { AppUser } from "../middleware/auth";

type AdminShellProps = PropsWithChildren<{
  user: AppUser;
  title?: string;
  active?: "dashboard" | "skus" | "batches" | "qr-codes" | "customers" | "audit-log" | "settings";
}>;

const NAV_ITEMS: { label: string; href: string; key: AdminShellProps["active"] }[] = [
  { label: "Dashboard", href: "/admin", key: "dashboard" },
  { label: "SKUs", href: "/admin/skus", key: "skus" },
  { label: "Batches", href: "/admin/batches", key: "batches" },
  { label: "QR Inventory", href: "/admin/qr-codes", key: "qr-codes" },
  { label: "Customers", href: "/admin/customers", key: "customers" },
  { label: "Audit Log", href: "/admin/audit-log", key: "audit-log" },
];

export const AdminShell: FC<AdminShellProps> = ({ user, title, active, children }) => (
  <>
    {raw("<!DOCTYPE html>")}
    <Layout title={title ?? "Admin — Sqanny"}>
      <div class="page">
        <header class="admin-header">
          <div class="admin-header-inner">
            <a href="/admin" class="admin-brand">Sqanny Admin</a>
            <nav class="admin-topnav" aria-label="Admin navigation">
              {NAV_ITEMS.map((item) => (
                <a
                  href={item.href}
                  class={`admin-topnav-link${active === item.key ? " admin-topnav-link--active" : ""}`}
                  aria-current={active === item.key ? "page" : undefined}
                >
                  {item.label}
                </a>
              ))}
            </nav>
            <div class="admin-header-right">
              <span class="admin-user-email">{user.email}</span>
              <a href="/app" class="admin-header-link">User Dashboard</a>
              <a href="/auth/logout" class="admin-header-link">Sign out</a>
            </div>
          </div>
        </header>
        <main class="admin-main">
          <div class="admin-container">{children}</div>
        </main>
      </div>
    </Layout>
  </>
);
