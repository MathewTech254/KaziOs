import { createBrowserRouter, Link, useRouteError } from "react-router-dom";
import { Layout } from "../components/Layout";
import { LoginPage } from "../pages/LoginPage";
import { RegisterPage } from "../pages/RegisterPage";
import { ForgotPasswordPage } from "../pages/ForgotPasswordPage";
import { ResetPasswordPage } from "../pages/ResetPasswordPage";
import { LandingPage } from "../pages/LandingPage";
import { DashboardPage } from "../pages/DashboardPage";
import { ProductsPage } from "../pages/ProductsPage";
import { CustomersPage } from "../pages/CustomersPage";
import { InvoicesPage } from "../pages/InvoicesPage";
import { ReportsPage } from "../pages/ReportsPage";
import { PosPage } from "../pages/PosPage";
import { PaymentsPage } from "../pages/PaymentsPage";
import { SettingsPage } from "../pages/SettingsPage";
import { InventoryPage } from "../pages/InventoryPage";
import { PurchasingPage } from "../pages/PurchasingPage";
import { ExpensesPage } from "../pages/ExpensesPage";
import { PricingPage } from "../pages/PricingPage";
import { AuthGuard } from "../components/Guard";

/**
 * Shown for a URL that matches nothing.
 *
 * Without this the router matched no branch and rendered an empty page, which reads as
 * a crash rather than a wrong address. A broken link is a normal thing to hit, and it
 * should say so and offer a way back.
 */
function NotFound() {
  const error = useRouteError() as { status?: number; statusText?: string } | null;
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background px-6 text-center">
      <p className="kazi-display text-5xl font-semibold tracking-tight text-foreground">
        {error?.status === 404 ? "404" : "Something went wrong"}
      </p>
      <h1 className="text-lg font-medium text-foreground">
        {error?.status === 404 ? "That page does not exist." : "We could not load this page."}
      </h1>
      <p className="max-w-md text-sm text-muted-foreground">
        The address may have been mistyped, or the page may have moved. Everything else in the
        workspace is still where you left it.
      </p>
      <div className="mt-2 flex flex-wrap items-center justify-center gap-3">
        <Link to="/dashboard" className="kazi-button-primary px-4 py-2 text-sm">
          Go to dashboard
        </Link>
        <Link to="/" className="kazi-button-secondary px-4 py-2 text-sm">
          Go home
        </Link>
      </div>
    </div>
  );
}

export const router = createBrowserRouter([
  {
    path: "/",
    element: <LandingPage />,
  },
  {
    path: "/login",
    element: <LoginPage />,
  },
  {
    // Public on purpose: somebody deciding whether to sign up has to be able to read the
    // prices without creating an account first. The page works signed out, and shows the
    // signed in business their current plan when there is one.
    path: "/pricing",
    element: <PricingPage />,
  },
  {
    path: "/register",
    element: <RegisterPage />,
  },
  {
    path: "/forgot-password",
    element: <ForgotPasswordPage />,
  },
  {
    path: "/reset-password",
    element: <ResetPasswordPage />,
  },
  {
    path: "/pos",
    element: (
      <AuthGuard>
        <Layout />
      </AuthGuard>
    ),
    children: [{ index: true, element: <PosPage /> }],
  },
  {
    path: "/settings",
    element: (
      <AuthGuard>
        <Layout />
      </AuthGuard>
    ),
    children: [{ index: true, element: <SettingsPage /> }],
  },
  {
    path: "/inventory",
    element: (
      <AuthGuard>
        <Layout />
      </AuthGuard>
    ),
    children: [{ index: true, element: <InventoryPage /> }],
  },
  {
    path: "/purchases",
    element: (
      <AuthGuard>
        <Layout />
      </AuthGuard>
    ),
    children: [{ index: true, element: <PurchasingPage /> }],
  },
  {
    path: "/expenses",
    element: (
      <AuthGuard>
        <Layout />
      </AuthGuard>
    ),
    children: [{ index: true, element: <ExpensesPage /> }],
  },
  {
    path: "/dashboard",
    element: (
      <AuthGuard>
        <Layout />
      </AuthGuard>
    ),
    children: [
      { index: true, element: <DashboardPage /> },
      { path: "products", element: <ProductsPage /> },
      { path: "customers", element: <CustomersPage /> },
      { path: "invoices", element: <InvoicesPage /> },
      { path: "reports", element: <ReportsPage /> },
      { path: "payments", element: <PaymentsPage /> },
    ],
  },
  {
    // The catch all. It sits last so every real route above still wins, and it means
    // an unknown address explains itself instead of rendering nothing at all.
    path: "*",
    element: <NotFound />,
  },
]);
