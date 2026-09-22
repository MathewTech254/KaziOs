import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowUpRight } from "lucide-react";
import { AuthBrandPanel } from "../components/AuthBrandPanel";
import { BrandLogo } from "../components/BrandLogo";
import { useAuth } from "../contexts/AuthContext";

export function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const { login } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await login(email, password);
      navigate("/dashboard");
    } catch (err: any) {
      setError(err.response?.data?.error || "Login failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="kazi-auth-shell flex min-h-screen items-center justify-center p-4 sm:p-8 lg:p-10">
      <div className="kazi-auth-frame">
        <div className="kazi-auth-column w-full max-w-[31rem] justify-self-center">
          <div className="mb-7 flex items-center justify-between gap-4 sm:mb-8">
            <Link to="/" aria-label="Return to KaziOS home" className="flex items-center gap-3">
              <BrandLogo variant="mark" className="h-11 w-11" />
              <div>
                <p className="kazi-display text-lg font-semibold text-[var(--kazi-display-text)]">KaziOS</p>
                <p className="text-[10px] font-semibold uppercase tracking-[.2em] text-[var(--kazi-muted-text)]">Business operating system</p>
              </div>
            </Link>
            <Link to="/" className="text-sm text-[var(--kazi-muted-text)] transition-colors hover:text-[var(--kazi-text)]">Back home</Link>
          </div>

          <div className="mb-6 sm:mb-7">
            <p className="mb-3 text-[11px] font-semibold uppercase tracking-[.22em] text-[var(--kazi-accent)]">Sign in</p>
            <h1 className="kazi-display text-3xl font-semibold tracking-[-.055em] text-[var(--kazi-display-text)] sm:text-4xl">Welcome back to your workspace.</h1>
            <p className="mt-3 max-w-md text-sm leading-6 text-[var(--kazi-body-text)]">Pick up the work that keeps your business moving.</p>
          </div>

          <div className="kazi-auth-card p-6 sm:p-8">
            <form onSubmit={handleSubmit} className="space-y-5">
              <div>
                <label htmlFor="login-email" className="mb-2 block text-sm font-medium text-[var(--kazi-text)]">Email</label>
                <input
                  id="login-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="kazi-input"
                  placeholder="you@company.com"
                  autoComplete="email"
                  required
                />
              </div>
              <div>
                <label htmlFor="login-password" className="mb-2 block text-sm font-medium text-[var(--kazi-text)]">Password</label>
                <input
                  id="login-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="kazi-input"
                  placeholder="••••••••"
                  autoComplete="current-password"
                  required
                />
              </div>
              {error && <p role="alert" className="text-sm text-danger">{error}</p>}
              <button type="submit" disabled={loading} className="kazi-button-primary w-full px-4">
                {loading ? "Signing in..." : "Sign in"}
                {!loading && <ArrowUpRight className="h-4 w-4" aria-hidden="true" />}
              </button>
            </form>

            <p className="mt-6 text-center text-sm text-[var(--kazi-body-text)]">
              Don&apos;t have an account?{" "}
              <Link to="/register" className="font-semibold text-[var(--kazi-accent)] underline underline-offset-4 hover:text-[var(--kazi-accent-hover)]">Create one</Link>
            </p>
          </div>

          <div className="kazi-auth-note mt-4">
            <p className="text-xs leading-5 text-[var(--kazi-muted-text)]">
              <strong className="text-[var(--kazi-text)]">Demo access:</strong> If you have already set up the demo seed, use <code className="text-[var(--kazi-accent)]">admin@kazios.dev</code> / <code className="text-[var(--kazi-accent)]">admin123</code>.
            </p>
          </div>
        </div>

        <AuthBrandPanel mode="login" />
      </div>
    </div>
  );
}
