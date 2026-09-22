export * from "./payment";
export * from "./etims";
export * from "./storage";
export * from "./email";
export * from "./sms";
export * from "./whatsapp";

export interface IntegrationProvider {
  name: string;
  isConfigured: boolean;
  healthCheck(): Promise<IntegrationHealthResult>;
}

export interface IntegrationHealthResult {
  status: "healthy" | "degraded" | "unhealthy";
  provider: string;
  message?: string;
}
