export default function PricingPage() {
  return (
    <div className="max-w-4xl mx-auto px-4 py-16">
      <h1 className="text-4xl font-bold mb-8 text-center">Pricing</h1>
      <div className="grid gap-8 md:grid-cols-3">
        <div className="p-6 border border-border rounded-lg">
          <h3 className="text-xl font-semibold mb-2">Starter</h3>
          <p className="text-3xl font-bold mb-4">$9<span className="text-sm font-normal">/mo</span></p>
          <ul className="space-y-2 text-sm text-muted-foreground">
            <li>100 QR codes</li>
            <li>1,000 scans/mo</li>
            <li>Basic analytics</li>
          </ul>
        </div>
        <div className="p-6 border-2 border-brand-500 rounded-lg">
          <h3 className="text-xl font-semibold mb-2">Pro</h3>
          <p className="text-3xl font-bold mb-4">$29<span className="text-sm font-normal">/mo</span></p>
          <ul className="space-y-2 text-sm text-muted-foreground">
            <li>1,000 QR codes</li>
            <li>10,000 scans/mo</li>
            <li>Advanced analytics</li>
          </ul>
        </div>
        <div className="p-6 border border-border rounded-lg">
          <h3 className="text-xl font-semibold mb-2">Enterprise</h3>
          <p className="text-3xl font-bold mb-4">Custom</p>
          <ul className="space-y-2 text-sm text-muted-foreground">
            <li>Unlimited QR codes</li>
            <li>Unlimited scans</li>
            <li>Custom solutions</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
