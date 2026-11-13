import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "../contexts/AuthContext";
import { LoginPage } from "./LoginPage";

jest.mock("../lib/api", () => ({
  api: { get: jest.fn(), post: jest.fn(), put: jest.fn(), patch: jest.fn(), delete: jest.fn() },
  apiHost: () => "",
  getApiError: (err: unknown) => (err as Error)?.message || "error",
}));

function renderLogin() {
  return render(
    <MemoryRouter initialEntries={["/login"]}>
      <AuthProvider>
        <LoginPage />
      </AuthProvider>
    </MemoryRouter>
  );
}

describe("LoginPage", () => {
  it("renders the sign in form without throwing", () => {
    renderLogin();

    expect(screen.getByRole("heading", { name: /welcome back to your workspace/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /sign in/i })).toBeInTheDocument();
  });

  it("offers the account recovery links", () => {
    renderLogin();

    expect(screen.getByRole("link", { name: /create one/i })).toHaveAttribute("href", "/register");
    expect(screen.getByRole("link", { name: /forgot your password/i })).toHaveAttribute(
      "href",
      "/forgot-password"
    );
  });
});