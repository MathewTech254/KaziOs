import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { api, getApiError } from "../lib/api";

export function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await api.post("/auth/forgot-password", { email: email.trim() });
      // The same confirmation is shown either way, so this screen cannot be used to
      // find out which email addresses have accounts.
      setSent(true);
    } catch (err) {
      setError(getApiError(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="kazi-auth-shell flex min-h-screen items-center justify-center p-4 sm:p-8">
      <div className="kazi-auth-column w-full max-w-[31rem]">
        <Link to="/login" className="mb-8 inline-flex items-center gap-2 text-sm text-[var(--kazi-muted-text)] hover:text-[var(--kazi-text)]">
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Back to sign in
        </Link>

        <div className="mb-6">
          <p className="mb-3 text-[11px] font-semibold uppercase tracking-[.22em] text-[var(--kazi-accent)]">Password</p>
          <h1 className="kazi-display text-3xl font-semibold tracking-[-.055em] text-[var(--kazi-display-text)]">
            Reset your password
          </h1>
        </div>

        <div className="kazi-auth-card p-6 sm:p-8">
          {sent ? (
            <div>
              <p className="text-sm leading-6 text-[var(--kazi-body-text)]">
                If that address belongs to a KaziOS account, a reset link is on its way. It works once and expires in 15
                minutes.
              </p>
              <p className="mt-4 text-sm text-[var(--kazi-muted-text)]">
                Nothing arrived? Check the spam folder, or make sure you used the address you signed up with.
              </p>
              <Link to="/login" className="mt-6 inline-block text-sm font-semibold text-[var(--kazi-accent)] underline underline-offset-4">
                Back to sign in
              </Link>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-5">
              <p className="text-sm leading-6 text-[var(--kazi-body-text)]">
                Enter the email you use for KaziOS and we will send you a link to choose a new password.
              </p>
              {error && (
                <p role="alert" className="rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
                  {error}
                </p>
              )}
              <div>
                <label htmlFor="forgot-email" className="mb-2 block text-sm font-medium text-[var(--kazi-text)]">
                  Email
                </label>
                <input
                  id="forgot-email"
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="kazi-input"
                />
              </div>
              <button type="submit" disabled={loading} className="kazi-button-primary w-full px-4 py-3 text-sm disabled:opacity-60">
                {loading ? "Sending..." : "Send reset link"}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
