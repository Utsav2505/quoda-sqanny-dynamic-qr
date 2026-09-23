import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { formatDate, formatNumber } from "@/lib/utils";
import { Plus, Search, Boxes } from "lucide-react";

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
}

export default function AdminBatchList() {
  const [batches, setBatches] = useState<Batch[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  useEffect(() => {
    api.get("/api/admin/batches")
      .then((data) => setBatches((data as any).batches || []))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const filteredBatches = batches.filter(
    (batch) =>
      batch.batch_number.toLowerCase().includes(search.toLowerCase()) ||
      batch.sku_name?.toLowerCase().includes(search.toLowerCase())
  );

  const statusVariant = (status: string) => {
    switch (status) {
      case "completed": return "success";
      case "failed": return "destructive";
      case "generating": return "info";
      default: return "warning";
    }
  };

  if (loading) return <LoadingSpinner className="min-h-[400px]" />;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Batches</h1>
          <p className="text-muted-foreground mt-1">Manage QR code batches</p>
        </div>
        <Link to="/admin/batches/new">
          <Button>
            <Plus className="h-4 w-4 mr-2" />
            Create Batch
          </Button>
        </Link>
      </div>

      {/* Search */}
      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search batches..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9"
        />
      </div>

      {/* Stats */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Batches</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{batches.length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total QR Codes</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatNumber(batches.reduce((acc, b) => acc + b.quantity, 0))}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Generated</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatNumber(batches.reduce((acc, b) => acc + (b.generated_count ?? 0), 0))}</div>
          </CardContent>
        </Card>
      </div>

      {/* Table */}
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Batch #</TableHead>
                <TableHead>SKU</TableHead>
                <TableHead className="text-center">Quantity</TableHead>
                <TableHead className="text-center">Generated</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredBatches.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-8">
                    <Boxes className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
                    <p className="text-muted-foreground">
                      {search ? "No batches match your search" : "No batches yet. Create your first batch to get started."}
                    </p>
                  </TableCell>
                </TableRow>
              ) : (
                filteredBatches.map((batch) => (
                  <TableRow key={batch.id}>
                    <TableCell>
                      <Link to={`/admin/batches/${batch.id}`} className="font-mono font-medium hover:text-brand-500">
                        {batch.batch_number}
                      </Link>
                    </TableCell>
                    <TableCell>{batch.sku_name}</TableCell>
                    <TableCell className="text-center">{formatNumber(batch.quantity)}</TableCell>
                    <TableCell className="text-center">{formatNumber(batch.generated_count ?? 0)}</TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(batch.status) as any}>
                        {batch.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{formatDate(batch.created_at)}</TableCell>
                    <TableCell className="text-right">
                      <Link to={`/admin/batches/${batch.id}`}>
                        <Button variant="ghost" size="sm">View</Button>
                      </Link>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
