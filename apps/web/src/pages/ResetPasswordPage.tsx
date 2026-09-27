import { useEffect, useState } from "react";
import { Link, useSearchParams, useNavigate } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { api, getApiError } from "../lib/api";

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get("token") ?? "";

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [state, setState] = useState<"checking" | "ready" | "dead">("checking");
  const [problem, setProblem] = useState("");
  const [account, setAccount] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // Check the link before asking for a new password, so a dead link is refused up
  // front instead of after the user has typed a password they will not get to keep.
  useEffect(() => {
    if (!token) {
      setState("dead");
      setProblem("This reset link is missing its token.");
      return;
    }
    api
      .post("/auth/reset-password/verify", { token })
      .then((res) => {
        setAccount(res.data.data.email ?? "");
        setState("ready");
      })
      .catch((err) => {
        setState("dead");
        setProblem(getApiError(err));
      });
  }, [token]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    setLoading(true);
    try {
      await api.post("/auth/reset-password", { token, password, confirmPassword });
      navigate("/login");
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
            Choose a new password
          </h1>
        </div>

        <div className="kazi-auth-card p-6 sm:p-8">
          {state === "checking" && <p className="text-sm text-[var(--kazi-muted-text)]">Checking your link...</p>}

          {state === "dead" && (
            <div>
              <p role="alert" className="rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
                {problem}
              </p>
              <Link to="/forgot-password" className="mt-6 inline-block text-sm font-semibold text-[var(--kazi-accent)] underline underline-offset-4">
                Request a new link
              </Link>
            </div>
          )}

          {state === "ready" && (
            <form onSubmit={submit} className="space-y-5">
              {account && <p className="text-sm text-[var(--kazi-muted-text)]">For {account}</p>}
              {error && (
                <p role="alert" className="rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
                  {error}
                </p>
              )}
              <div>
                <label htmlFor="reset-password" className="mb-2 block text-sm font-medium text-[var(--kazi-text)]">
                  New password
                </label>
                <input
                  id="reset-password"
                  type="password"
                  required
                  minLength={8}
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="kazi-input"
                />
                <p className="mt-2 text-xs text-[var(--kazi-muted-text)]">At least 8 characters.</p>
              </div>
              <div>
                <label htmlFor="reset-confirm" className="mb-2 block text-sm font-medium text-[var(--kazi-text)]">
                  Confirm new password
                </label>
                <input
                  id="reset-confirm"
                  type="password"
                  required
                  minLength={8}
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="kazi-input"
                />
              </div>
              <p className="text-xs leading-5 text-[var(--kazi-muted-text)]">
                Changing your password signs you out everywhere else, so anyone else using this account is locked out.
              </p>
              <button type="submit" disabled={loading} className="kazi-button-primary w-full px-4 py-3 text-sm disabled:opacity-60">
                {loading ? "Saving..." : "Save new password"}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
