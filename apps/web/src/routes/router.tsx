import { createBrowserRouter } from "react-router-dom";
import { Layout } from "../components/Layout";
import { LoginPage } from "../pages/LoginPage";
import { RegisterPage } from "../pages/RegisterPage";
import { LandingPage } from "../pages/LandingPage";
import { DashboardPage } from "../pages/DashboardPage";
import { ProductsPage } from "../pages/ProductsPage";
import { CustomersPage } from "../pages/CustomersPage";
import { InvoicesPage } from "../pages/InvoicesPage";
import { ReportsPage } from "../pages/ReportsPage";
import { PosPage } from "../pages/PosPage";
import { PaymentsPage } from "../pages/PaymentsPage";
import { AuthGuard } from "../components/Guard";

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
    path: "/register",
    element: <RegisterPage />,
  },
  {
    path: "/pos",
    element: (
      <AuthGuard>
        <Layout />
      </AuthGuard>
    ),
    children: [
      { index: true, element: <PosPage /> },
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
]);