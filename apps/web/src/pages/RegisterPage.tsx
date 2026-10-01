import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowUpRight, CheckCircle, Eye, EyeOff } from "lucide-react";
import { AuthBrandPanel } from "../components/AuthBrandPanel";
import { BrandLogo } from "../components/BrandLogo";
import { useAuth } from "../contexts/AuthContext";

interface FormData {
  name: string;
  email: string;
  password: string;
  confirmPassword: string;
  organizationName: string;
  country: string;
  currency: string;
  timezone: string;
}

export function RegisterPage() {
  const [form, setForm] = useState<FormData>({
    name: "",
    email: "",
    password: "",
    confirmPassword: "",
    organizationName: "",
    country: "KE",
    currency: "KES",
    timezone: "Africa/Nairobi",
  });
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const { register } = useAuth();
  const navigate = useNavigate();

  const passwordRequirements = [
    { met: form.password.length >= 8, label: "At least 8 characters" },
    { met: /[A-Z]/.test(form.password), label: "One uppercase letter" },
    { met: /[0-9]/.test(form.password), label: "One number" },
  ];

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (form.password !== form.confirmPassword) {
      setError("Passwords do not match");
      return;
    }
    setLoading(true);
    try {
      await register(form);
      navigate("/dashboard");
    } catch (err: any) {
      setError(err.response?.data?.error || "Registration failed");
    } finally {
      setLoading(false);
    }
  };

  const inputClass = "kazi-input";

  return (
    <div className="kazi-auth-shell flex min-h-screen items-center justify-center p-4 sm:p-8 lg:p-10">
      <div className="kazi-auth-frame">
        <div className="kazi-auth-column w-full max-w-[42rem] justify-self-center">
          <div className="mb-7 flex items-center justify-between gap-4 sm:mb-8">
            <Link to="/" aria-label="Return to KaziOS home" className="flex items-center gap-3">
              <BrandLogo variant="mark" className="h-11 w-11" />
              <div>
                <p className="kazi-display text-lg font-semibold text-[var(--kazi-display-text)]">
                  KaziOS
                </p>
                <p className="text-[10px] font-semibold uppercase tracking-[.2em] text-[var(--kazi-muted-text)]">
                  Business operating system
                </p>
              </div>
            </Link>
            <Link
              to="/"
              className="text-sm text-[var(--kazi-muted-text)] transition-colors hover:text-[var(--kazi-text)]"
            >
              Back home
            </Link>
          </div>

          <div className="mb-6 sm:mb-7">
            <p className="mb-3 text-[11px] font-semibold uppercase tracking-[.22em] text-[var(--kazi-accent)]">
              Create your workspace
            </p>
            <h1 className="kazi-display text-3xl font-semibold tracking-[-.055em] text-[var(--kazi-display-text)] sm:text-4xl">
              Set up a clearer way to operate.
            </h1>
            <p className="mt-3 max-w-xl text-sm leading-6 text-[var(--kazi-body-text)]">
              Start managing the work behind your business from one dependable operating view.
            </p>
          </div>

          <div className="kazi-auth-card p-6 sm:p-8">
            <form onSubmit={handleSubmit} className="space-y-5">
              <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                <div>
                  <label
                    htmlFor="register-name"
                    className="mb-2 block text-sm font-medium text-[var(--kazi-text)]"
                  >
                    Full name
                  </label>
                  <input
                    id="register-name"
                    value={form.name}
                    onChange={e => setForm({ ...form, name: e.target.value })}
                    className={inputClass}
                    placeholder="John Doe"
                    autoComplete="name"
                    required
                  />
                </div>
                <div>
                  <label
                    htmlFor="register-email"
                    className="mb-2 block text-sm font-medium text-[var(--kazi-text)]"
                  >
                    Email
                  </label>
                  <input
                    id="register-email"
                    type="email"
                    value={form.email}
                    onChange={e => setForm({ ...form, email: e.target.value })}
                    className={inputClass}
                    placeholder="you@company.com"
                    autoComplete="email"
                    required
                  />
                </div>
              </div>

              <div>
                <label
                  htmlFor="register-organization"
                  className="mb-2 block text-sm font-medium text-[var(--kazi-text)]"
                >
                  Organization name
                </label>
                <input
                  id="register-organization"
                  value={form.organizationName}
                  onChange={e => setForm({ ...form, organizationName: e.target.value })}
                  className={inputClass}
                  placeholder="Acme Ltd"
                  autoComplete="organization"
                  required
                />
              </div>

              <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                <div>
                  <label
                    htmlFor="register-country"
                    className="mb-2 block text-sm font-medium text-[var(--kazi-text)]"
                  >
                    Country
                  </label>
                  <select
                    id="register-country"
                    value={form.country}
                    onChange={e => setForm({ ...form, country: e.target.value })}
                    className={inputClass}
                  >
                    <option value="KE">Kenya</option>
                    <option value="UG">Uganda</option>
                    <option value="TZ">Tanzania</option>
                    <option value="NG">Nigeria</option>
                    <option value="ZA">South Africa</option>
                  </select>
                </div>
                <div>
                  <label
                    htmlFor="register-currency"
                    className="mb-2 block text-sm font-medium text-[var(--kazi-text)]"
                  >
                    Currency
                  </label>
                  <select
                    id="register-currency"
                    value={form.currency}
                    onChange={e => setForm({ ...form, currency: e.target.value })}
                    className={inputClass}
                  >
                    <option value="KES">KES</option>
                    <option value="UGX">UGX</option>
                    <option value="TZS">TZS</option>
                    <option value="NGN">NGN</option>
                    <option value="ZAR">ZAR</option>
                    <option value="USD">USD</option>
                  </select>
                </div>
              </div>

              <div>
                <label
                  htmlFor="register-password"
                  className="mb-2 block text-sm font-medium text-[var(--kazi-text)]"
                >
                  Password
                </label>
                <div className="relative">
                  <input
                    id="register-password"
                    type={showPassword ? "text" : "password"}
                    value={form.password}
                    onChange={e => setForm({ ...form, password: e.target.value })}
                    className={`${inputClass} pr-12`}
                    placeholder="••••••••"
                    autoComplete="new-password"
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-2 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-md text-[var(--kazi-muted-text)] transition-colors hover:text-[var(--kazi-text)]"
                    aria-label={showPassword ? "Hide password" : "Show password"}
                  >
                    {showPassword ? (
                      <EyeOff className="h-4 w-4" aria-hidden="true" />
                    ) : (
                      <Eye className="h-4 w-4" aria-hidden="true" />
                    )}
                  </button>
                </div>
                <div className="mt-3 grid gap-1.5 sm:grid-cols-3">
                  {passwordRequirements.map(req => (
                    <div key={req.label} className="flex items-center gap-2">
                      <CheckCircle
                        className={`h-3.5 w-3.5 ${req.met ? "text-success" : "text-[var(--kazi-muted-text)] opacity-40"}`}
                        aria-hidden="true"
                      />
                      <span
                        className={`text-xs ${req.met ? "text-success" : "text-[var(--kazi-muted-text)]"}`}
                      >
                        {req.label}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <label
                  htmlFor="register-confirm-password"
                  className="mb-2 block text-sm font-medium text-[var(--kazi-text)]"
                >
                  Confirm password
                </label>
                <input
                  id="register-confirm-password"
                  type={showPassword ? "text" : "password"}
                  value={form.confirmPassword}
                  onChange={e => setForm({ ...form, confirmPassword: e.target.value })}
                  className={inputClass}
                  placeholder="••••••••"
                  autoComplete="new-password"
                  required
                />
              </div>

              {error && (
                <p role="alert" className="text-sm text-danger">
                  {error}
                </p>
              )}

              <button type="submit" disabled={loading} className="kazi-button-primary w-full px-4">
                {loading ? "Creating account..." : "Create account"}
                {!loading && <ArrowUpRight className="h-4 w-4" aria-hidden="true" />}
              </button>
            </form>

            <p className="mt-6 text-center text-sm text-[var(--kazi-body-text)]">
              Already have an account?{" "}
              <Link
                to="/login"
                className="font-semibold text-[var(--kazi-accent)] underline underline-offset-4 hover:text-[var(--kazi-accent-hover)]"
              >
                Sign in
              </Link>
            </p>
          </div>
        </div>

        <AuthBrandPanel mode="register" />
      </div>
    </div>
  );
}
