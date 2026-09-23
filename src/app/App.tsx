import { Routes, Route } from "react-router-dom";
import { Suspense, lazy } from "react";
import { LoadingSpinner } from "@/components/ui/loading-spinner";

// Marketing pages
const MarketingLayout = lazy(() => import("@/components/layout/marketing-layout"));
const HomePage = lazy(() => import("@/pages/marketing/home"));
const FeaturesPage = lazy(() => import("@/pages/marketing/features"));
const PricingPage = lazy(() => import("@/pages/marketing/pricing"));
const UseCasesPage = lazy(() => import("@/pages/marketing/use-cases"));
const DocsPage = lazy(() => import("@/pages/marketing/docs"));

// Auth pages
const LoginPage = lazy(() => import("@/pages/auth/login"));
const VerifyPage = lazy(() => import("@/pages/auth/verify"));

// Admin pages
const AdminLayout = lazy(() => import("@/components/layout/admin-layout"));
const AdminDashboard = lazy(() => import("@/pages/admin/dashboard"));
const AdminSkuList = lazy(() => import("@/pages/admin/skus/list"));
const AdminSkuCreate = lazy(() => import("@/pages/admin/skus/create"));
const AdminSkuDetail = lazy(() => import("@/pages/admin/skus/detail"));
const AdminSkuEdit = lazy(() => import("@/pages/admin/skus/edit"));
const AdminBatchList = lazy(() => import("@/pages/admin/batches/list"));
const AdminBatchCreate = lazy(() => import("@/pages/admin/batches/create"));
const AdminBatchDetail = lazy(() => import("@/pages/admin/batches/detail"));
const AdminQrInventory = lazy(() => import("@/pages/admin/qr-codes/inventory"));
const AdminQrDetail = lazy(() => import("@/pages/admin/qr-codes/detail"));
const AdminCustomerList = lazy(() => import("@/pages/admin/customers/list"));
const AdminCustomerDetail = lazy(() => import("@/pages/admin/customers/detail"));
const AdminAuditLog = lazy(() => import("@/pages/admin/audit-log"));
const AdminSettings = lazy(() => import("@/pages/admin/settings"));

// Customer pages
const CustomerLayout = lazy(() => import("@/components/layout/customer-layout"));
const CustomerDashboard = lazy(() => import("@/pages/customer/dashboard"));
const CustomerStands = lazy(() => import("@/pages/customer/stands"));
const CustomerAddStand = lazy(() => import("@/pages/customer/add-stand"));
const CustomerStandDetail = lazy(() => import("@/pages/customer/stand-detail"));
const CustomerStandSetup = lazy(() => import("@/pages/customer/stand-setup"));
const CustomerProfile = lazy(() => import("@/pages/customer/profile"));

// Shared
const NotFoundPage = lazy(() => import("@/pages/not-found"));

export function App() {
  return (
    <Suspense fallback={<LoadingSpinner className="min-h-screen" />}>
      <Routes>
        {/* Marketing */}
        <Route element={<MarketingLayout />}>
          <Route path="/" element={<HomePage />} />
          <Route path="/features" element={<FeaturesPage />} />
          <Route path="/pricing" element={<PricingPage />} />
          <Route path="/use-cases" element={<UseCasesPage />} />
          <Route path="/docs" element={<DocsPage />} />
        </Route>

        {/* Auth */}
        <Route path="/login" element={<LoginPage />} />
        <Route path="/auth/verify" element={<VerifyPage />} />
        <Route path="/auth/logout" element={<div>Logging out...</div>} />

        {/* Admin */}
        <Route path="/admin" element={<AdminLayout />}>
          <Route index element={<AdminDashboard />} />
          <Route path="skus" element={<AdminSkuList />} />
          <Route path="skus/new" element={<AdminSkuCreate />} />
          <Route path="skus/:id" element={<AdminSkuDetail />} />
          <Route path="skus/:id/edit" element={<AdminSkuEdit />} />
          <Route path="batches" element={<AdminBatchList />} />
          <Route path="batches/new" element={<AdminBatchCreate />} />
          <Route path="batches/:id" element={<AdminBatchDetail />} />
          <Route path="qr-codes" element={<AdminQrInventory />} />
          <Route path="qr-codes/:id" element={<AdminQrDetail />} />
          <Route path="customers" element={<AdminCustomerList />} />
          <Route path="customers/:id" element={<AdminCustomerDetail />} />
          <Route path="audit-log" element={<AdminAuditLog />} />
          <Route path="settings" element={<AdminSettings />} />
        </Route>

        {/* Customer */}
        <Route path="/customer" element={<CustomerLayout />}>
          <Route index element={<CustomerDashboard />} />
          <Route path="stands" element={<CustomerStands />} />
          <Route path="add-stand" element={<CustomerAddStand />} />
          <Route path="stands/:id" element={<CustomerStandDetail />} />
          <Route path="stands/:id/setup" element={<CustomerStandSetup />} />
          <Route path="profile" element={<CustomerProfile />} />
        </Route>

        {/* Catch all */}
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </Suspense>
  );
}
