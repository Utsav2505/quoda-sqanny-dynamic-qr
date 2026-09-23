import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "@/lib/api";
import { toast } from "sonner";

export default function CustomerAddStand() {
  const navigate = useNavigate();
  const [form, setForm] = useState({
    name: "",
    slug: "",
  });
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      await api.post("/api/customer/stands", form);
      toast.success("Stand created successfully");
      navigate("/customer/stands");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create stand");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-2xl space-y-6">
      <h1 className="text-3xl font-bold">Add Stand</h1>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium mb-2">Name</label>
          <input
            type="text"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            required
            placeholder="My Stand"
            className="w-full px-4 py-2 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-2">Slug</label>
          <input
            type="text"
            value={form.slug}
            onChange={(e) => setForm({ ...form, slug: e.target.value })}
            required
            placeholder="my-stand"
            pattern="[a-z0-9-]+"
            className="w-full px-4 py-2 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500 font-mono"
          />
          <p className="text-sm text-muted-foreground mt-1">
            Only lowercase letters, numbers, and hyphens allowed.
          </p>
        </div>
        <div className="flex gap-4">
          <button
            type="submit"
            disabled={loading}
            className="px-4 py-2 bg-brand-500 text-white rounded-lg font-medium hover:bg-brand-600 disabled:opacity-50 transition-colors"
          >
            {loading ? "Creating..." : "Create Stand"}
          </button>
          <button
            type="button"
            onClick={() => navigate("/customer/stands")}
            className="px-4 py-2 border border-border rounded-lg font-medium hover:bg-accent transition-colors"
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
