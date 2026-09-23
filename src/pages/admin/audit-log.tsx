import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { formatDateTime } from "@/lib/utils";
import { Search, FileText } from "lucide-react";

interface AuditEntry {
  id: string;
  action: string;
  actor_email: string;
  target_type: string;
  target_id: string;
  details: string;
  created_at: number;
}

const actionColors: Record<string, string> = {
  "sku.create": "bg-emerald-100 text-emerald-700",
  "sku.update": "bg-sky-100 text-sky-700",
  "batch.create": "bg-amber-100 text-amber-700",
  "batch.generate": "bg-purple-100 text-purple-700",
  "qr.scan": "bg-brand-100 text-brand-700",
  "qr.claim": "bg-emerald-100 text-emerald-700",
  "user.login": "bg-gray-100 text-gray-700",
};

export default function AdminAuditLog() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  useEffect(() => {
    api.get("/api/admin/audit-log")
      .then((data) => setEntries((data as any).entries || []))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const filteredEntries = entries.filter(
    (entry) =>
      entry.action.toLowerCase().includes(search.toLowerCase()) ||
      entry.actor_email?.toLowerCase().includes(search.toLowerCase()) ||
      entry.target_type?.toLowerCase().includes(search.toLowerCase())
  );

  if (loading) return <LoadingSpinner className="min-h-[400px]" />;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Audit Log</h1>
        <p className="text-muted-foreground mt-1">Track all system activities</p>
      </div>

      {/* Search */}
      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search audit log..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9"
        />
      </div>

      {/* Table */}
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Actor</TableHead>
                <TableHead>Target</TableHead>
                <TableHead>Details</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredEntries.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center py-8">
                    <FileText className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
                    <p className="text-muted-foreground">
                      {search ? "No entries match your search" : "No audit entries found"}
                    </p>
                  </TableCell>
                </TableRow>
              ) : (
                filteredEntries.map((entry) => (
                  <TableRow key={entry.id}>
                    <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                      {formatDateTime(entry.created_at)}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={actionColors[entry.action] || ""}
                      >
                        {entry.action}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm">{entry.actor_email}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{entry.target_type}</TableCell>
                    <TableCell className="text-sm text-muted-foreground max-w-xs truncate">
                      {entry.details || "-"}
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
