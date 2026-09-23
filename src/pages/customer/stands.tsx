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

export default function CustomerStands() {
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
      <div className="border border-border rounded-lg">
        <table className="w-full">
          <thead>
            <tr className="border-b border-border">
              <th className="text-left p-4 font-medium">Name</th>
              <th className="text-left p-4 font-medium">Slug</th>
              <th className="text-left p-4 font-medium">QR Codes</th>
              <th className="text-left p-4 font-medium">Status</th>
              <th className="text-left p-4 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {stands.map((stand) => (
              <tr key={stand.id} className="border-b border-border last:border-0">
                <td className="p-4 font-medium">{stand.name}</td>
                <td className="p-4 text-muted-foreground">/{stand.slug}</td>
                <td className="p-4">{stand.qr_count}</td>
                <td className="p-4">
                  <span className={`px-2 py-1 rounded-full text-xs font-medium status-${stand.status}`}>
                    {stand.status}
                  </span>
                </td>
                <td className="p-4">
                  <Link to={`/customer/stands/${stand.id}`} className="text-brand-500 hover:underline">
                    View
                  </Link>
                </td>
              </tr>
            ))}
            {stands.length === 0 && (
              <tr>
                <td colSpan={5} className="p-8 text-center text-muted-foreground">
                  No stands yet. Add your first stand to get started.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
