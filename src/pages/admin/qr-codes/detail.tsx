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
import { ArrowLeft, ExternalLink, Copy, Download } from "lucide-react";

interface QrCodeDetail {
  id: string;
  serial_number: string;
  short_code: string;
  status: string;
  batch_number: string;
  target_url: string;
  customer_email: string;
  stand_name: string;
  scan_count: number;
  last_scanned_at: number | null;
  created_at: number;
  updated_at: number;
}

export default function AdminQrDetail() {
  const { id } = useParams();
  const [qr, setQr] = useState<QrCodeDetail | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get(`/api/admin/qr-codes/${id}`)
      .then((data) => setQr((data as any).qr))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [id]);

  const handleCopyShortCode = async () => {
    if (!qr) return;
    await copyToClipboard(qr.short_code);
    toast.success("Short code copied to clipboard");
  };

  const handleCopyUrl = async () => {
    if (!qr) return;
    await copyToClipboard(qr.short_code);
    toast.success("Redirect URL copied to clipboard");
  };

  const statusVariant = (status: string) => {
    switch (status) {
      case "active": return "success";
      case "disabled": return "secondary";
      case "retired": return "destructive";
      default: return "info";
    }
  };

  if (loading) return <LoadingSpinner className="min-h-[400px]" />;
  if (!qr) return <div className="text-center py-8">QR code not found</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link to="/admin/qr-codes">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-bold font-mono">{qr.serial_number}</h1>
            <Badge variant={statusVariant(qr.status) as any}>
              {qr.status}
            </Badge>
          </div>
          <p className="text-muted-foreground mt-1">Batch: {qr.batch_number}</p>
        </div>
        <Button variant="outline">
          <Download className="h-4 w-4 mr-2" />
          Export
        </Button>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        {/* Short Code */}
        <Card>
          <CardHeader>
            <CardTitle>Short Code</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-2">
              <code className="flex-1 p-3 bg-muted rounded-lg text-lg font-mono text-center">
                {qr.short_code}
              </code>
              <Button variant="outline" size="icon" onClick={handleCopyShortCode}>
                <Copy className="h-4 w-4" />
              </Button>
            </div>
            <div className="flex items-center gap-2">
              <code className="flex-1 p-2 bg-muted rounded text-sm break-all">
                {qr.short_code}
              </code>
              <Button variant="outline" size="icon" onClick={handleCopyUrl}>
                <Copy className="h-4 w-4" />
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Target URL */}
        <Card>
          <CardHeader>
            <CardTitle>Target URL</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-2">
              <code className="flex-1 p-2 bg-muted rounded text-sm break-all">
                {qr.target_url || "Not configured"}
              </code>
              {qr.target_url && (
                <Button variant="outline" size="icon" asChild>
                  <a href={qr.target_url} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="h-4 w-4" />
                  </a>
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Assignment */}
        <Card>
          <CardHeader>
            <CardTitle>Assignment</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <p className="text-sm text-muted-foreground">Customer</p>
              <p>{qr.customer_email || "Unassigned"}</p>
            </div>
            <Separator />
            <div>
              <p className="text-sm text-muted-foreground">Stand</p>
              <p>{qr.stand_name || "Not assigned to a stand"}</p>
            </div>
          </CardContent>
        </Card>

        {/* Analytics */}
        <Card>
          <CardHeader>
            <CardTitle>Analytics</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <p className="text-sm text-muted-foreground">Total Scans</p>
              <p className="text-3xl font-bold">{qr.scan_count ?? 0}</p>
            </div>
            <Separator />
            <div>
              <p className="text-sm text-muted-foreground">Last Scanned</p>
              <p>{qr.last_scanned_at ? formatDate(qr.last_scanned_at) : "Never"}</p>
            </div>
          </CardContent>
        </Card>

        {/* Timestamps */}
        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle>Timeline</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <p className="text-sm text-muted-foreground">Created</p>
                <p>{formatDate(qr.created_at)}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Last Updated</p>
                <p>{formatDate(qr.updated_at)}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
