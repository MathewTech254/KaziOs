import { useState, useEffect, createContext, useContext, ReactNode, useCallback } from "react";
import { api } from "../lib/api";

interface User {
  id: string;
  email: string;
  name: string;
  phone?: string;
  status: string;
  organizationId: string;
  roles: { type: string; permissions: string[]; branchId?: string; warehouseId?: string }[];
}

interface AuthContextType {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (data: RegisterData) => Promise<void>;
  logout: () => Promise<void>;
  hasPermission: (perm: string) => boolean;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

interface RegisterData {
  name: string;
  email: string;
  password: string;
  organizationName: string;
  country: string;
  currency: string;
  timezone: string;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem("kazios_token");
    if (token) {
      api
        .get("/auth/me")
        .then((res) => {
          setUser(res.data.data);
          localStorage.setItem("kazios_user", JSON.stringify(res.data.data));
        })
        .catch(() => localStorage.removeItem("kazios_token"))
        .finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
  }, []);

  const login = async (email: string, password: string) => {
    const res = await api.post("/auth/login", { email, password });
    localStorage.setItem("kazios_token", res.data.data.token);
    localStorage.setItem("kazios_user", JSON.stringify(res.data.data.user));
    setUser(res.data.data.user);
  };

  const register = async (data: RegisterData) => {
    const res = await api.post("/auth/register", data);
    localStorage.setItem("kazios_token", res.data.data.token);
    localStorage.setItem("kazios_user", JSON.stringify(res.data.data.user));
    setUser(res.data.data.user);
  };

  const logout = async () => {
    try { await api.post("/auth/logout"); } catch {}
    localStorage.removeItem("kazios_token");
    localStorage.removeItem("kazios_user");
    setUser(null);
  };

  const hasPermission = useCallback((perm: string) => {
    if (!user) return false;
    return user.roles.some((r) => r.permissions.includes("*") || r.permissions.includes(perm));
  }, [user]);

  return (
    <AuthContext.Provider value={{ user, loading, login, register, logout, hasPermission }}>
      {children}
    </AuthContext.Provider>
  );
}