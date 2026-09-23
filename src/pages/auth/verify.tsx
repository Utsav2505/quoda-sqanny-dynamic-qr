import { useEffect } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { useAuth } from "@/app/providers/auth-provider";

export default function VerifyPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { refresh } = useAuth();

  useEffect(() => {
    const token = searchParams.get("token");
    if (token) {
      // The token is handled by the server via cookie
      refresh().then(() => {
        navigate("/admin");
      });
    }
  }, [searchParams, navigate, refresh]);

  return (
    <div className="flex min-h-screen items-center justify-center">
      <p className="text-muted-foreground">Verifying your login...</p>
    </div>
  );
}
