import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { formatDate, formatNumber } from "@/lib/utils";
import { ArrowLeft, ExternalLink, Download } from "lucide-react";

interface Batch {
  id: string;
  batch_number: string;
  sku_id: string;
  sku_name: string;
  quantity: number;
  generated_count: number;
  status: string;
  note: string;
  created_at: number;
  updated_at: number;
}

export default function AdminBatchDetail() {
  const { id } = useParams();
  const [batch, setBatch] = useState<Batch | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get(`/api/admin/batches/${id}`)
      .then((data) => setBatch((data as any).batch))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [id]);

  const progress = batch ? (batch.generated_count / batch.quantity) * 100 : 0;

  const statusVariant = (status: string) => {
    switch (status) {
      case "completed": return "success";
      case "failed": return "destructive";
      case "generating": return "info";
      default: return "warning";
    }
  };

  if (loading) return <LoadingSpinner className="min-h-[400px]" />;
  if (!batch) return <div className="text-center py-8">Batch not found</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link to="/admin/batches">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-bold font-mono">{batch.batch_number}</h1>
            <Badge variant={statusVariant(batch.status) as any}>
              {batch.status}
            </Badge>
          </div>
          <p className="text-muted-foreground mt-1">
            {batch.note || `Batch for ${batch.sku_name}`}
          </p>
        </div>
        {batch.status === "completed" && (
          <Button>
            <Download className="h-4 w-4 mr-2" />
            Export CSV
          </Button>
        )}
      </div>

      {/* Progress */}
      {batch.status === "generating" && (
        <Card>
          <CardContent className="pt-6">
            <div className="space-y-2">
              <div className="flex justify-between text-sm">
                <span>Generating QR codes...</span>
                <span>{formatNumber(batch.generated_count)} / {formatNumber(batch.quantity)}</span>
              </div>
              <Progress value={progress} />
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 md:grid-cols-2">
        {/* Batch Info */}
        <Card>
          <CardHeader>
            <CardTitle>Batch Information</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <p className="text-sm text-muted-foreground">SKU</p>
              <Link to={`/admin/skus/${batch.sku_id}`} className="font-medium hover:text-brand-500">
                {batch.sku_name}
              </Link>
            </div>
            <Separator />
            <div>
              <p className="text-sm text-muted-foreground">Quantity</p>
              <p className="text-2xl font-bold">{formatNumber(batch.quantity)}</p>
            </div>
            <Separator />
            <div>
              <p className="text-sm text-muted-foreground">Generated</p>
              <p className="text-2xl font-bold">{formatNumber(batch.generated_count ?? 0)}</p>
            </div>
          </CardContent>
        </Card>

        {/* Timestamps */}
        <Card>
          <CardHeader>
            <CardTitle>Timeline</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <p className="text-sm text-muted-foreground">Created</p>
              <p>{formatDate(batch.created_at)}</p>
            </div>
            <Separator />
            <div>
              <p className="text-sm text-muted-foreground">Last Updated</p>
              <p>{formatDate(batch.updated_at)}</p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
