export const NODE_ENV = {
  DEVELOPMENT: "development",
  PRODUCTION: "production",
  TEST: "test",
} as const;

export type NodeEnv = (typeof NODE_ENV)[keyof typeof NODE_ENV];

export type Currency = "KES" | "UGX" | "TZS" | "NGN" | "ZAR" | "USD" | "EUR" | "GBP";

export type CountryCode = "KE" | "UG" | "TZ" | "NG" | "ZA" | "US" | "GB" | "EU";

export interface EnvironmentConfig {
  nodeEnv: NodeEnv;
  databaseUrl: string;
  redisUrl: string;
  sessionSecret: string;
  jwtSecret: string;
  jwtExpiresIn: string;
  bcryptRounds: number;
  appUrl: string;
  apiUrl: string;
  paystack: {
    secretKey?: string;
    publicKey?: string;
    webhookSecret?: string;
  };
  etims: {
    apiUrl?: string;
    clientId?: string;
    clientSecret?: string;
    certificate?: string;
    tin?: string;
  };
  email: {
    provider: string;
    apiKey?: string;
    from: string;
    fromName: string;
  };
  sms: {
    provider: string;
    apiKey?: string;
    from?: string;
  };
  whatsapp: {
    provider: string;
    apiKey?: string;
    from?: string;
  };
  storage: {
    provider: string;
    bucket: string;
    endpoint?: string;
    accessKey?: string;
    secretKey?: string;
    region?: string;
  };
  ai: {
    provider?: string;
    apiKey?: string;
    model: string;
    maxTokens: number;
    temperature: number;
  };
  security: {
    corsOrigin: string;
    rateLimitWindowMs: number;
    rateLimitMax: number;
  };
  encryptionKey: string;
  enableRegistration: boolean;
  enableDemoSeed: boolean;
  logLevel: string;
}

function getEnv(name: string, fallback?: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`Environment variable ${name} is required but not set`);
  }
  return value;
}

function getEnvOptional(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined || value === "") return undefined;
  return value;
}

function getEnvNumber(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) return fallback;
  return parsed;
}

function getEnvBoolean(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return value === "true" || value === "1";
}

export function loadConfig(): EnvironmentConfig {
  return {
    nodeEnv: getEnv("NODE_ENV", "development") as NodeEnv,
    databaseUrl: getEnv("DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/kazios?schema=public"),
    redisUrl: getEnv("REDIS_URL", "redis://localhost:6379"),
    sessionSecret: getEnv("SESSION_SECRET", "dev-session-secret-change-in-production-min-32chars"),
    jwtSecret: getEnv("JWT_SECRET", "dev-jwt-secret-change-in-production-min-32chars"),
    jwtExpiresIn: getEnv("JWT_EXPIRES_IN", "7d"),
    bcryptRounds: getEnvNumber("BCRYPT_ROUNDS", 12),
    appUrl: getEnv("APP_URL", "http://localhost:3000"),
    apiUrl: getEnv("API_URL", "http://localhost:4000"),
    paystack: {
      secretKey: getEnvOptional("PAYSTACK_SECRET_KEY"),
      publicKey: getEnvOptional("PAYSTACK_PUBLIC_KEY"),
      webhookSecret: getEnvOptional("PAYSTACK_WEBHOOK_SECRET"),
    },
    etims: {
      apiUrl: getEnvOptional("ETIMS_API_URL"),
      clientId: getEnvOptional("ETIMS_CLIENT_ID"),
      clientSecret: getEnvOptional("ETIMS_CLIENT_SECRET"),
      certificate: getEnvOptional("ETIMS_CERTIFICATE"),
      tin: getEnvOptional("ETIMS_TIN"),
    },
    email: {
      provider: getEnv("EMAIL_PROVIDER", "console"),
      apiKey: getEnvOptional("EMAIL_API_KEY"),
      from: getEnv("EMAIL_FROM", "no-reply@kazios.test"),
      fromName: getEnv("EMAIL_FROM_NAME", "KaziOS"),
    },
    sms: {
      provider: getEnv("SMS_PROVIDER", "console"),
      apiKey: getEnvOptional("SMS_API_KEY"),
      from: getEnvOptional("SMS_FROM"),
    },
    whatsapp: {
      provider: getEnv("WHATSAPP_PROVIDER", "console"),
      apiKey: getEnvOptional("WHATSAPP_API_KEY"),
      from: getEnvOptional("WHATSAPP_FROM"),
    },
    storage: {
      provider: getEnv("OBJECT_STORAGE_PROVIDER", "local"),
      bucket: getEnv("OBJECT_STORAGE_BUCKET", "kazios"),
      endpoint: getEnvOptional("OBJECT_STORAGE_ENDPOINT"),
      accessKey: getEnvOptional("OBJECT_STORAGE_ACCESS_KEY"),
      secretKey: getEnvOptional("OBJECT_STORAGE_SECRET_KEY"),
      region: getEnvOptional("OBJECT_STORAGE_REGION"),
    },
    ai: {
      provider: getEnvOptional("AI_PROVIDER"),
      apiKey: getEnvOptional("AI_API_KEY"),
      model: getEnv("AI_MODEL", "gpt-4o-mini"),
      maxTokens: getEnvNumber("AI_MAX_TOKENS", 4000),
      temperature: parseFloat(getEnv("AI_TEMPERATURE", "0.1")),
    },
    security: {
      corsOrigin: getEnv("CORS_ORIGIN", "http://localhost:3000"),
      rateLimitWindowMs: getEnvNumber("RATE_LIMIT_WINDOW_MS", 60000),
      rateLimitMax: getEnvNumber("RATE_LIMIT_MAX", 100),
    },
    encryptionKey: getEnv("ENCRYPTION_KEY", "dev-encryption-key-32-bytes-min!!!1"),
    enableRegistration: getEnvBoolean("ENABLE_REGISTRATION", true),
    enableDemoSeed: getEnvBoolean("ENABLE_DEMO_SEED", true),
    logLevel: getEnv("LOG_LEVEL", "debug"),
  };
}

export const isProduction = (config: EnvironmentConfig) => config.nodeEnv === NODE_ENV.PRODUCTION;
export const isDevelopment = (config: EnvironmentConfig) => config.nodeEnv === NODE_ENV.DEVELOPMENT;

export const isPaystackConfigured = (config: EnvironmentConfig) =>
  Boolean(config.paystack.secretKey && config.paystack.webhookSecret);

export const isTimsConfigured = (config: EnvironmentConfig) =>
  Boolean(config.etims.apiUrl && config.etims.clientId && config.etims.clientSecret);

export const isAiConfigured = (config: EnvironmentConfig) =>
  Boolean(config.ai.provider && config.ai.apiKey);
