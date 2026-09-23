export default function UseCasesPage() {
  return (
    <div className="max-w-4xl mx-auto px-4 py-16">
      <h1 className="text-4xl font-bold mb-8">Use Cases</h1>
      <div className="space-y-6">
        <div className="p-6 border border-border rounded-lg">
          <h3 className="text-xl font-semibold mb-2">Retail & E-commerce</h3>
          <p className="text-muted-foreground">Link physical products to digital experiences.</p>
        </div>
        <div className="p-6 border border-border rounded-lg">
          <h3 className="text-xl font-semibold mb-2">Events & Marketing</h3>
          <p className="text-muted-foreground">Track campaign engagement across channels.</p>
        </div>
        <div className="p-6 border border-border rounded-lg">
          <h3 className="text-xl font-semibold mb-2">Real Estate</h3>
          <p className="text-muted-foreground">Dynamic property listings and virtual tours.</p>
        </div>
      </div>
    </div>
  );
}
