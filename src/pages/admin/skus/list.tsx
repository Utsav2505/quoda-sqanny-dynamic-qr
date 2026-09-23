import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { formatDate } from "@/lib/utils";
import { Plus, Search, Package } from "lucide-react";

interface Sku {
  id: string;
  name: string;
  description: string;
  target_url: string;
  batch_count: number;
  qr_count: number;
  created_at: number;
}

export default function AdminSkuList() {
  const [skus, setSkus] = useState<Sku[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  useEffect(() => {
    api.get("/api/admin/skus")
      .then((data) => setSkus((data as any).skus || []))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const filteredSkus = skus.filter(
    (sku) =>
      sku.name.toLowerCase().includes(search.toLowerCase()) ||
      sku.description?.toLowerCase().includes(search.toLowerCase())
  );

  if (loading) return <LoadingSpinner className="min-h-[400px]" />;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">SKUs</h1>
          <p className="text-muted-foreground mt-1">Manage your product SKUs</p>
        </div>
        <Link to="/admin/skus/new">
          <Button>
            <Plus className="h-4 w-4 mr-2" />
            Create SKU
          </Button>
        </Link>
      </div>

      {/* Search */}
      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search SKUs..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9"
        />
      </div>

      {/* Stats */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total SKUs</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{skus.length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Batches</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{skus.reduce((acc, sku) => acc + (sku.batch_count ?? 0), 0)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total QR Codes</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{skus.reduce((acc, sku) => acc + (sku.qr_count ?? 0), 0)}</div>
          </CardContent>
        </Card>
      </div>

      {/* Table */}
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Description</TableHead>
                <TableHead className="text-center">Batches</TableHead>
                <TableHead className="text-center">QR Codes</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredSkus.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center py-8">
                    <Package className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
                    <p className="text-muted-foreground">
                      {search ? "No SKUs match your search" : "No SKUs yet. Create your first SKU to get started."}
                    </p>
                  </TableCell>
                </TableRow>
              ) : (
                filteredSkus.map((sku) => (
                  <TableRow key={sku.id}>
                    <TableCell>
                      <Link to={`/admin/skus/${sku.id}`} className="font-medium hover:text-brand-500">
                        {sku.name}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground max-w-xs truncate">
                      {sku.description || "-"}
                    </TableCell>
                    <TableCell className="text-center">
                      <Badge variant="outline">{sku.batch_count ?? 0}</Badge>
                    </TableCell>
                    <TableCell className="text-center">
                      <Badge variant="outline">{sku.qr_count ?? 0}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{formatDate(sku.created_at)}</TableCell>
                    <TableCell className="text-right">
                      <Link to={`/admin/skus/${sku.id}`}>
                        <Button variant="ghost" size="sm">View</Button>
                      </Link>
                      <Link to={`/admin/skus/${sku.id}/edit`}>
                        <Button variant="ghost" size="sm">Edit</Button>
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
