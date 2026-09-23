import { Link } from "react-router-dom";

export default function HomePage() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] text-center px-4">
      <h1 className="text-4xl font-bold mb-4">
        Dynamic QR Codes That{" "}
        <span className="text-brand-500">Never Break</span>
      </h1>
      <p className="text-lg text-muted-foreground max-w-2xl mb-8">
        Track engagement, manage locations, and gain powerful analytics.
        Update destinations anytime without reprinting.
      </p>
      <div className="flex gap-4">
        <Link
          to="/login"
          className="px-6 py-3 bg-brand-500 text-white rounded-lg font-medium hover:bg-brand-600 transition-colors"
        >
          Get Started
        </Link>
        <Link
          to="/features"
          className="px-6 py-3 border border-border rounded-lg font-medium hover:bg-accent transition-colors"
        >
          Learn More
        </Link>
      </div>
    </div>
  );
}
