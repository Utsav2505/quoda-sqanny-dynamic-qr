export default function FeaturesPage() {
  return (
    <div className="max-w-4xl mx-auto px-4 py-16">
      <h1 className="text-4xl font-bold mb-8">Features</h1>
      <div className="grid gap-8 md:grid-cols-2">
        <div className="p-6 border border-border rounded-lg">
          <h3 className="text-xl font-semibold mb-2">Dynamic Destinations</h3>
          <p className="text-muted-foreground">Change where your QR codes point without reprinting.</p>
        </div>
        <div className="p-6 border border-border rounded-lg">
          <h3 className="text-xl font-semibold mb-2">Scan Analytics</h3>
          <p className="text-muted-foreground">Track scans by time, location, and device.</p>
        </div>
        <div className="p-6 border border-border rounded-lg">
          <h3 className="text-xl font-semibold mb-2">QR Generator</h3>
          <p className="text-muted-foreground">Generate QR codes with custom designs and logos.</p>
        </div>
        <div className="p-6 border border-border rounded-lg">
          <h3 className="text-xl font-semibold mb-2">Batch Management</h3>
          <p className="text-muted-foreground">Create and manage thousands of QR codes at once.</p>
        </div>
      </div>
    </div>
  );
}
