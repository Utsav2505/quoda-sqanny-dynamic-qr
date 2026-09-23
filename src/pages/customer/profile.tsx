import { useAuth } from "@/app/providers/auth-provider";
import { LoadingSpinner } from "@/components/ui/loading-spinner";

export default function CustomerProfile() {
  const { user, loading } = useAuth();

  if (loading) return <LoadingSpinner className="min-h-[400px]" />;

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold">Profile</h1>
      <div className="max-w-2xl space-y-6">
        <div className="p-6 border border-border rounded-lg">
          <h3 className="text-lg font-semibold mb-4">Account Details</h3>
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium text-muted-foreground">Email</label>
              <p>{user?.email || "Not available"}</p>
            </div>
            <div>
              <label className="text-sm font-medium text-muted-foreground">Plan</label>
              <p className="capitalize">{user?.plan_id || "Free"}</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
