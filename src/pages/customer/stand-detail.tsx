import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { api } from "@/lib/api";
import { LoadingSpinner } from "@/components/ui/loading-spinner";

interface Stand {
  id: string;
  name: string;
  slug: string;
  qr_count: number;
  status: string;
}

export default function CustomerStandDetail() {
  const { id } = useParams();
  const [stand, setStand] = useState<Stand | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get(`/api/customer/stands/${id}`)
      .then((data) => setStand(data.stand))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) return <LoadingSpinner className="min-h-[400px]" />;
  if (!stand) return <div className="text-center py-8">Stand not found</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">{stand.name}</h1>
        <span className={`px-3 py-1 rounded-full text-sm font-medium status-${stand.status}`}>
          {stand.status}
        </span>
      </div>
      <div className="grid gap-6 md:grid-cols-2">
        <div className="space-y-4">
          <div>
            <h3 className="text-sm font-medium text-muted-foreground">Slug</h3>
            <code className="font-mono">/{stand.slug}</code>
          </div>
          <div>
            <h3 className="text-sm font-medium text-muted-foreground">QR Codes</h3>
            <p>{stand.qr_count}</p>
          </div>
        </div>
        <div className="space-y-4">
          <Link
            to={`/customer/stands/${stand.id}/setup`}
            className="block p-4 border border-border rounded-lg hover:border-brand-500 transition-colors"
          >
            <h3 className="font-semibold mb-1">Setup Destination</h3>
            <p className="text-sm text-muted-foreground">Configure where your QR codes point to.</p>
          </Link>
        </div>
      </div>
      <div className="pt-4">
        <Link to="/customer/stands" className="text-brand-500 hover:underline">
          ← Back to Stands
        </Link>
      </div>
    </div>
  );
}
