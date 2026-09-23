import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "@/lib/api";
import { LoadingSpinner } from "@/components/ui/loading-spinner";

interface Stand {
  id: string;
  name: string;
  slug: string;
  qr_count: number;
  status: string;
}

export default function CustomerDashboard() {
  const [stands, setStands] = useState<Stand[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get("/api/customer/stands")
      .then((data) => setStands(data.stands || []))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <LoadingSpinner className="min-h-[400px]" />;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">My Stands</h1>
        <Link
          to="/customer/add-stand"
          className="px-4 py-2 bg-brand-500 text-white rounded-lg font-medium hover:bg-brand-600 transition-colors"
        >
          Add Stand
        </Link>
      </div>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {stands.map((stand) => (
          <Link
            key={stand.id}
            to={`/customer/stands/${stand.id}`}
            className="p-6 border border-border rounded-lg hover:border-brand-500 transition-colors"
          >
            <h3 className="font-semibold mb-2">{stand.name}</h3>
            <p className="text-sm text-muted-foreground mb-4">/{stand.slug}</p>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">{stand.qr_count} QR codes</span>
              <span className={`px-2 py-1 rounded-full text-xs font-medium status-${stand.status}`}>
                {stand.status}
              </span>
            </div>
          </Link>
        ))}
        {stands.length === 0 && (
          <div className="col-span-full text-center py-12 text-muted-foreground">
            No stands yet. Add your first stand to get started.
          </div>
        )}
      </div>
    </div>
  );
}
