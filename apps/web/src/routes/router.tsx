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
import { ReturnsPage } from "../pages/ReturnsPage";
import { PaymentsPage } from "../pages/PaymentsPage";
import { SettingsPage } from "../pages/SettingsPage";
import { InventoryPage } from "../pages/InventoryPage";
import { PurchasingPage } from "../pages/PurchasingPage";
import { ReceiveStockPage } from "../pages/ReceiveStockPage";
import { StocktakePage } from "../pages/StocktakePage";
import { ExpensesPage } from "../pages/ExpensesPage";
import { ClosingPage } from "../pages/ClosingPage";
import { OnboardingWizard } from "../pages/OnboardingWizard";
import { PricingPage } from "../pages/PricingPage";
import { AssistantPage } from "../pages/AssistantPage";
import { AuthGuard } from "../components/Guard";

/**
 * Shown for a URL that matches nothing.
 *
 * This is the catch-all route, so the address genuinely does not exist: there is no
 * route error to read, and asking for one is why this page used to announce "Something
 * went wrong" for a mistyped URL. A real crash is handled by RouteError below.
 */
function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background px-6 text-center">
      <p className="kazi-display text-5xl font-semibold tracking-tight text-foreground">404</p>
      <h1 className="text-lg font-medium text-foreground">That page does not exist.</h1>
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

/**
 * Shown when a route throws while rendering.
 *
 * A crash inside a page is not the same as an address that does not exist, so it gets its
 * own message and a way back rather than a 404 that would send somebody hunting for a
 * typo in a URL that was correct.
 */
function RouteError() {
  const error = useRouteError() as { statusText?: string; message?: string } | null;
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background px-6 text-center">
      <p className="kazi-display text-5xl font-semibold tracking-tight text-foreground">Oh no</p>
      <h1 className="text-lg font-medium text-foreground">Something went wrong.</h1>
      <p className="max-w-md text-sm text-muted-foreground">
        {error?.statusText ||
          error?.message ||
          "This page could not be loaded. Everything else in the workspace is still where you left it."}
      </p>
      <div className="mt-2 flex flex-wrap items-center justify-center gap-3">
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="kazi-button-primary px-4 py-2 text-sm"
        >
          Try again
        </button>
        <Link to="/" className="kazi-button-secondary px-4 py-2 text-sm">
          Go home
        </Link>
      </div>
    </div>
  );
}

export const router = createBrowserRouter([
  {
    // Sign in has to be reachable: the guard sends every signed out visitor here, the
    // 401 handler in the API client sends them here, and the landing, pricing, register
    // and reset pages all link to it. Without this entry every one of those paths fell
    // through to the catch all and rendered "Something went wrong".
    path: "/login",
    element: <LoginPage />,
  },
  {
    path: "/",
    element: <LandingPage />,
  },
  {
    path: "/pricing",
    element: <PricingPage />,
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
    path: "/onboarding",
    element: (
      <AuthGuard>
        <Layout />
      </AuthGuard>
    ),
    children: [{ index: true, element: <OnboardingWizard /> }],
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
    // Its own route rather than a tab on the invoices list: a return is found by receipt
    // number from a piece of paper, which is a different job from reading the invoice book.
    path: "/returns",
    element: (
      <AuthGuard>
        <Layout />
      </AuthGuard>
    ),
    children: [{ index: true, element: <ReturnsPage /> }],
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
    children: [
      {
        index: true,
        element: <PurchasingPage />,
      },
    ],
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
    path: "/stock/receive",
    element: (
      <AuthGuard>
        <Layout />
      </AuthGuard>
    ),
    children: [
      {
        index: true,
        element: <ReceiveStockPage />,
      },
    ],
  },
  {
    path: "/stocktake",
    element: (
      <AuthGuard>
        <Layout />
      </AuthGuard>
    ),
    children: [
      {
        index: true,
        element: <StocktakePage />,
      },
    ],
  },
  {
    path: "/closing",
    element: (
      <AuthGuard>
        <Layout />
      </AuthGuard>
    ),
    children: [
      {
        index: true,
        element: <ClosingPage />,
      },
    ],
  },
  {
    path: "/assistant",
    element: (
      <AuthGuard>
        <Layout />
      </AuthGuard>
    ),
    children: [
      {
        index: true,
        element: <AssistantPage />,
      },
    ],
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
  // Every route gets the same boundary, so a page that throws while rendering reports
  // itself rather than being mistaken for a missing address.
].map(route => ({ errorElement: <RouteError />, ...route })));
