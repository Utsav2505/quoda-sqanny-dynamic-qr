import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { api } from "@/lib/api";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { toast } from "sonner";

interface Stand {
  id: string;
  name: string;
  slug: string;
  target_url: string;
}

export default function CustomerStandSetup() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [stand, setStand] = useState<Stand | null>(null);
  const [targetUrl, setTargetUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get(`/api/customer/stands/${id}`)
      .then((data) => {
        setStand(data.stand);
        setTargetUrl(data.stand.target_url || "");
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [id]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api.put(`/api/customer/stands/${id}`, { target_url: targetUrl });
      toast.success("Destination updated successfully");
      navigate(`/customer/stands/${id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update destination");
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <LoadingSpinner className="min-h-[400px]" />;
  if (!stand) return <div className="text-center py-8">Stand not found</div>;

  return (
    <div className="max-w-2xl space-y-6">
      <h1 className="text-3xl font-bold">Setup Destination</h1>
      <p className="text-muted-foreground">
        Configure where your QR codes for <strong>{stand.name}</strong> will point to.
        You can change this anytime without reprinting.
      </p>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium mb-2">Target URL</label>
          <input
            type="url"
            value={targetUrl}
            onChange={(e) => setTargetUrl(e.target.value)}
            required
            placeholder="https://example.com"
            className="w-full px-4 py-2 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>
        <div className="flex gap-4">
          <button
            type="submit"
            disabled={saving}
            className="px-4 py-2 bg-brand-500 text-white rounded-lg font-medium hover:bg-brand-600 disabled:opacity-50 transition-colors"
          >
            {saving ? "Saving..." : "Save Destination"}
          </button>
          <button
            type="button"
            onClick={() => navigate(`/customer/stands/${id}`)}
            className="px-4 py-2 border border-border rounded-lg font-medium hover:bg-accent transition-colors"
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
