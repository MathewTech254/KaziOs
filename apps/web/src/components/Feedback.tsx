import { AlertCircle, CheckCircle } from "lucide-react";

/** Inline status message used for errors and confirmations across pages. */
export function Notice({
  tone,
  title,
  message,
}: {
  tone: "error" | "success";
  title: string;
  message: string;
}) {
  const styles =
    tone === "error"
      ? "border-danger/40 bg-danger/10 text-danger"
      : "border-success/40 bg-success/10 text-success";
  const Icon = tone === "error" ? AlertCircle : CheckCircle;

  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={`mb-4 flex items-start gap-2 rounded-lg border p-3 text-sm ${styles}`}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div>
        <p className="font-medium">{title}</p>
        <p className="text-foreground/80">{message}</p>
      </div>
    </div>
  );
}

/**
 * Shown instead of a page whose data the signed in role may not read.
 *
 * Every page that loads from a permission guarded endpoint needs this. Without it the
 * request is made anyway, the API answers 403, and the browser reports an unhandled
 * rejection while the page renders an empty table — which reads as a broken product
 * rather than as a role that was never given the permission.
 */
export function AccessDenied({
  title,
  permission,
  hint,
}: {
  title: string;
  permission: string;
  hint?: string;
}) {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div className="kazi-card max-w-md p-8 text-center">
        <AlertCircle className="mx-auto mb-4 h-10 w-10 text-danger" aria-hidden="true" />
        <h1 className="kazi-page-title mb-2">{title}</h1>
        <p className="text-sm text-muted-foreground">
          {hint || "Your role does not include the permission this page needs."}
        </p>
        <p className="mt-3 text-xs text-muted-foreground">
          Ask an owner or administrator to grant{" "}
          <code className="rounded bg-surface-muted px-1 py-0.5">{permission}</code>.
        </p>
      </div>
    </div>
  );
}

export function LoadingBlock({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 p-6 text-sm text-muted-foreground">
      <span
        className="h-4 w-4 animate-spin rounded-full border-2 border-accent border-t-transparent"
        aria-hidden="true"
      />
      {label}
    </div>
  );
}

export function EmptyRow({ colSpan, message }: { colSpan: number; message: string }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-6 py-10 text-center text-sm text-muted-foreground">
        {message}
      </td>
    </tr>
  );
}
