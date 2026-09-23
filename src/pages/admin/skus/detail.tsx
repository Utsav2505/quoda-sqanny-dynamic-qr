import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { formatDate, copyToClipboard } from "@/lib/utils";
import { toast } from "sonner";
import { ArrowLeft, ExternalLink, Copy, Edit } from "lucide-react";

interface Sku {
  id: string;
  name: string;
  description: string;
  target_url: string;
  batch_count: number;
  qr_count: number;
  created_at: number;
  updated_at: number;
}

export default function AdminSkuDetail() {
  const { id } = useParams();
  const [sku, setSku] = useState<Sku | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get(`/api/admin/skus/${id}`)
      .then((data) => setSku((data as any).sku))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [id]);

  const handleCopyUrl = async () => {
    if (!sku?.target_url) return;
    await copyToClipboard(sku.target_url);
    toast.success("Target URL copied to clipboard");
  };

  if (loading) return <LoadingSpinner className="min-h-[400px]" />;
  if (!sku) return <div className="text-center py-8">SKU not found</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link to="/admin/skus">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-bold">{sku.name}</h1>
            <Badge variant="outline">SKU</Badge>
          </div>
          <p className="text-muted-foreground mt-1">{sku.description || "No description"}</p>
        </div>
        <Link to={`/admin/skus/${sku.id}/edit`}>
          <Button>
            <Edit className="h-4 w-4 mr-2" />
            Edit
          </Button>
        </Link>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        {/* Target URL */}
        <Card>
          <CardHeader>
            <CardTitle>Target URL</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-2">
              <code className="flex-1 p-2 bg-muted rounded text-sm break-all">
                {sku.target_url}
              </code>
              <Button variant="outline" size="icon" onClick={handleCopyUrl}>
                <Copy className="h-4 w-4" />
              </Button>
              <Button variant="outline" size="icon" asChild>
                <a href={sku.target_url} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="h-4 w-4" />
                </a>
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Statistics */}
        <Card>
          <CardHeader>
            <CardTitle>Statistics</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-sm text-muted-foreground">Batches</p>
                <p className="text-2xl font-bold">{sku.batch_count ?? 0}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">QR Codes</p>
                <p className="text-2xl font-bold">{sku.qr_count ?? 0}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Timestamps */}
        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle>Details</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <p className="text-sm text-muted-foreground">Created</p>
                <p>{formatDate(sku.created_at)}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Last Updated</p>
                <p>{formatDate(sku.updated_at)}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
