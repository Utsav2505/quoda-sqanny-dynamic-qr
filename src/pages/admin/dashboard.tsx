import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { formatDate, formatNumber } from "@/lib/utils";
import { QrCode, Boxes, Users, Activity, Plus, ArrowRight } from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from "recharts";

interface DashboardStats {
  totalQrCodes: number;
  activeQrCodes: number;
  totalBatches: number;
  totalScans: number;
  totalSkus: number;
  totalCustomers: number;
}

interface RecentBatch {
  id: string;
  batch_number: string;
  sku_name: string;
  quantity: number;
  status: string;
  created_at: number;
}

interface ScanData {
  date: string;
  scans: number;
}

const STATUS_COLORS = {
  pending: "#f59e0b",
  generating: "#0A7EA4",
  completed: "#10b981",
  failed: "#ef4444",
};

export default function AdminDashboard() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [recentBatches, setRecentBatches] = useState<RecentBatch[]>([]);
  const [scanData, setScanData] = useState<ScanData[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      api.get("/api/admin/dashboard/stats").catch(() => ({})),
      api.get("/api/admin/batches").catch(() => ({ batches: [] })),
      api.get("/api/admin/dashboard/scans").catch(() => ({ scans: [] })),
    ])
      .then(([statsData, batchesData, scansData]) => {
        setStats(statsData as DashboardStats);
        setRecentBatches((batchesData as any).batches?.slice(0, 5) || []);
        setScanData((scansData as any).scans || []);
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <LoadingSpinner className="min-h-[400px]" />;

  const statCards = [
    { title: "Total QR Codes", value: stats?.totalQrCodes ?? 0, icon: QrCode, href: "/admin/qr-codes" },
    { title: "Active QR Codes", value: stats?.activeQrCodes ?? 0, icon: Activity, href: "/admin/qr-codes" },
    { title: "Total Batches", value: stats?.totalBatches ?? 0, icon: Boxes, href: "/admin/batches" },
    { title: "Total Scans", value: stats?.totalScans ?? 0, icon: Activity, href: "/admin/audit-log" },
  ];

  const pieData = [
    { name: "Active", value: stats?.activeQrCodes ?? 0, color: "#0A7EA4" },
    { name: "Inactive", value: (stats?.totalQrCodes ?? 0) - (stats?.activeQrCodes ?? 0), color: "#e5e7eb" },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">Dashboard</h1>
        <div className="flex gap-2">
          <Link to="/admin/skus/new">
            <Button>
              <Plus className="h-4 w-4 mr-2" />
              New SKU
            </Button>
          </Link>
          <Link to="/admin/batches/new">
            <Button variant="outline">
              <Plus className="h-4 w-4 mr-2" />
              New Batch
            </Button>
          </Link>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {statCards.map((stat) => {
          const Icon = stat.icon;
          return (
            <Link key={stat.title} to={stat.href}>
              <Card className="hover:border-brand-500 transition-colors">
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">
                    {stat.title}
                  </CardTitle>
                  <Icon className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-3xl font-bold">{formatNumber(stat.value)}</div>
                </CardContent>
              </Card>
            </Link>
          );
        })}
      </div>

      {/* Charts Row */}
      <div className="grid gap-6 md:grid-cols-2">
        {/* Scan Activity Chart */}
        <Card>
          <CardHeader>
            <CardTitle>Scan Activity (Last 7 Days)</CardTitle>
          </CardHeader>
          <CardContent>
            {scanData.length > 0 ? (
              <ResponsiveContainer width="100%" height={250}>
                <BarChart data={scanData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="date" fontSize={12} />
                  <YAxis fontSize={12} />
                  <Tooltip />
                  <Bar dataKey="scans" fill="#0A7EA4" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-[250px] text-muted-foreground">
                No scan data yet
              </div>
            )}
          </CardContent>
        </Card>

        {/* QR Code Status */}
        <Card>
          <CardHeader>
            <CardTitle>QR Code Status</CardTitle>
          </CardHeader>
          <CardContent>
            {(stats?.totalQrCodes ?? 0) > 0 ? (
              <div className="flex items-center justify-center">
                <ResponsiveContainer width="100%" height={200}>
                  <PieChart>
                    <Pie
                      data={pieData}
                      cx="50%"
                      cy="50%"
                      innerRadius={60}
                      outerRadius={80}
                      paddingAngle={2}
                      dataKey="value"
                    >
                      {pieData.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={entry.color} />
                      ))}
                    </Pie>
                    <Tooltip />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <div className="flex items-center justify-center h-[200px] text-muted-foreground">
                No QR codes yet
              </div>
            )}
            <div className="flex justify-center gap-6 mt-4">
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-brand-500" />
                <span className="text-sm">Active</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-gray-200" />
                <span className="text-sm">Inactive</span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Recent Batches */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Recent Batches</CardTitle>
          <Link to="/admin/batches" className="text-sm text-brand-500 hover:underline flex items-center">
            View all <ArrowRight className="h-4 w-4 ml-1" />
          </Link>
        </CardHeader>
        <CardContent>
          {recentBatches.length > 0 ? (
            <div className="space-y-4">
              {recentBatches.map((batch) => (
                <div key={batch.id} className="flex items-center justify-between p-3 rounded-lg border border-border">
                  <div className="flex items-center gap-4">
                    <div>
                      <Link to={`/admin/batches/${batch.id}`} className="font-mono font-medium hover:text-brand-500">
                        {batch.batch_number}
                      </Link>
                      <p className="text-sm text-muted-foreground">{batch.sku_name}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-4">
                    <span className="text-sm text-muted-foreground">{batch.quantity} QR codes</span>
                    <Badge variant={batch.status === "completed" ? "success" : batch.status === "failed" ? "destructive" : "warning"}>
                      {batch.status}
                    </Badge>
                    <span className="text-sm text-muted-foreground">{formatDate(batch.created_at)}</span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              No batches yet.{" "}
              <Link to="/admin/batches/new" className="text-brand-500 hover:underline">
                Create your first batch
              </Link>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
