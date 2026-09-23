import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "@/lib/api";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { ArrowLeft, AlertCircle } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";

interface Sku {
  id: string;
  name: string;
  target_url: string;
}

export default function AdminBatchCreate() {
  const navigate = useNavigate();
  const [skus, setSkus] = useState<Sku[]>([]);
  const [form, setForm] = useState({
    sku_id: "",
    quantity: 10,
    note: "",
  });
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api.get("/api/admin/skus")
      .then((data) => setSkus((data as any).skus || []))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const selectedSku = skus.find((s) => s.id === form.sku_id);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await api.post("/api/admin/batches", form);
      toast.success("Batch created successfully");
      navigate("/admin/batches");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create batch");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <LoadingSpinner className="min-h-[400px]" />;

  return (
    <div className="max-w-2xl space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => navigate("/admin/batches")}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="text-3xl font-bold">Create Batch</h1>
          <p className="text-muted-foreground">Generate a new batch of QR codes</p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Batch Details</CardTitle>
          <CardDescription>Select an SKU and specify the quantity of QR codes to generate.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-6">
            <div className="space-y-2">
              <Label>SKU *</Label>
              <Select
                value={form.sku_id}
                onValueChange={(value) => setForm({ ...form, sku_id: value })}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select a SKU" />
                </SelectTrigger>
                <SelectContent>
                  {skus.map((sku) => (
                    <SelectItem key={sku.id} value={sku.id}>
                      {sku.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selectedSku && (
                <p className="text-sm text-muted-foreground">
                  Target: <code className="text-xs">{selectedSku.target_url}</code>
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="quantity">Quantity *</Label>
              <Input
                id="quantity"
                type="number"
                min="1"
                max="10000"
                value={form.quantity}
                onChange={(e) => setForm({ ...form, quantity: parseInt(e.target.value) || 0 })}
                required
              />
              <p className="text-sm text-muted-foreground">
                Number of QR codes to generate (1-10,000)
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="note">Note (optional)</Label>
              <Textarea
                id="note"
                value={form.note}
                onChange={(e) => setForm({ ...form, note: e.target.value })}
                placeholder="Internal note about this batch..."
                rows={3}
              />
            </div>

            {form.quantity > 1000 && (
              <Alert>
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>
                  Large batches may take several minutes to generate. You can monitor progress in the batch detail page.
                </AlertDescription>
              </Alert>
            )}

            <div className="flex gap-4">
              <Button type="submit" disabled={submitting || !form.sku_id}>
                {submitting ? "Creating..." : "Create Batch"}
              </Button>
              <Button type="button" variant="outline" onClick={() => navigate("/admin/batches")}>
                Cancel
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
