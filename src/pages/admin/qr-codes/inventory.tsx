import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { formatDate, copyToClipboard } from "@/lib/utils";
import { toast } from "sonner";
import { Search, QrCode, Copy, ChevronLeft, ChevronRight } from "lucide-react";

interface QrCodeItem {
  id: string;
  serial_number: string;
  short_code: string;
  status: string;
  batch_number: string;
  target_url: string;
  created_at: number;
}

const ITEMS_PER_PAGE = 20;

export default function AdminQrInventory() {
  const [qrCodes, setQrCodes] = useState<QrCodeItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [page, setPage] = useState(1);

  useEffect(() => {
    api.get("/api/admin/qr-codes")
      .then((data) => setQrCodes((data as any).qrCodes || []))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const filteredQrCodes = qrCodes.filter((qr) => {
    const matchesSearch =
      qr.serial_number.toLowerCase().includes(search.toLowerCase()) ||
      qr.short_code.toLowerCase().includes(search.toLowerCase()) ||
      qr.batch_number?.toLowerCase().includes(search.toLowerCase());
    const matchesStatus = statusFilter === "all" || qr.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const totalPages = Math.ceil(filteredQrCodes.length / ITEMS_PER_PAGE);
  const paginatedQrCodes = filteredQrCodes.slice(
    (page - 1) * ITEMS_PER_PAGE,
    page * ITEMS_PER_PAGE
  );

  const handleCopyShortCode = async (code: string) => {
    await copyToClipboard(code);
    toast.success("Short code copied to clipboard");
  };

  const statusVariant = (status: string) => {
    switch (status) {
      case "active": return "success";
      case "disabled": return "secondary";
      case "retired": return "destructive";
      default: return "info";
    }
  };

  const stats = {
    total: qrCodes.length,
    active: qrCodes.filter((q) => q.status === "active").length,
    available: qrCodes.filter((q) => q.status === "available").length,
    claimed: qrCodes.filter((q) => q.status === "claimed").length,
  };

  if (loading) return <LoadingSpinner className="min-h-[400px]" />;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">QR Code Inventory</h1>
        <p className="text-muted-foreground mt-1">Manage and track all QR codes</p>
      </div>

      {/* Stats */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.total}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Active</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-emerald-600">{stats.active}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Available</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-sky-600">{stats.available}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Claimed</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-amber-600">{stats.claimed}</div>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-4">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by serial, code, or batch..."
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            className="pl-9"
          />
        </div>
        <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v); setPage(1); }}>
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="Filter by status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Statuses</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="available">Available</SelectItem>
            <SelectItem value="claimed">Claimed</SelectItem>
            <SelectItem value="disabled">Disabled</SelectItem>
            <SelectItem value="retired">Retired</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Table */}
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Serial #</TableHead>
                <TableHead>Short Code</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Batch</TableHead>
                <TableHead>Target URL</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {paginatedQrCodes.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-8">
                    <QrCode className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
                    <p className="text-muted-foreground">
                      {search || statusFilter !== "all" ? "No QR codes match your filters" : "No QR codes found"}
                    </p>
                  </TableCell>
                </TableRow>
              ) : (
                paginatedQrCodes.map((qr) => (
                  <TableRow key={qr.id}>
                    <TableCell className="font-mono text-sm">{qr.serial_number}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <code className="font-mono text-sm">{qr.short_code}</code>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6"
                          onClick={() => handleCopyShortCode(qr.short_code)}
                        >
                          <Copy className="h-3 w-3" />
                        </Button>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(qr.status) as any}>
                        {qr.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono text-sm">{qr.batch_number}</TableCell>
                    <TableCell className="max-w-[200px] truncate text-sm text-muted-foreground">
                      {qr.target_url || "-"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{formatDate(qr.created_at)}</TableCell>
                    <TableCell className="text-right">
                      <Link to={`/admin/qr-codes/${qr.id}`}>
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

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            Showing {(page - 1) * ITEMS_PER_PAGE + 1} to{" "}
            {Math.min(page * ITEMS_PER_PAGE, filteredQrCodes.length)} of{" "}
            {filteredQrCodes.length} results
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage(page - 1)}
              disabled={page === 1}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="text-sm">
              Page {page} of {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage(page + 1)}
              disabled={page === totalPages}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
