import {
  corsOriginWarning,
  mailConfigurationWarning,
  productionEnvProblems,
} from "./productionEnv";

/**
 * A server that cannot send mail still looks perfectly healthy from outside: it answers a
 * password reset exactly as though it had sent the link. These warnings are what stop that
 * from being discovered by a customer rather than by a log.
 */
describe("mail configuration warning", () => {
  const original = { ...process.env };

  afterEach(() => {
    process.env = { ...original };
  });

  it("says nothing when mail is properly configured", () => {
    process.env.EMAIL_PROVIDER = "resend";
    process.env.EMAIL_API_KEY = "re_live_something";
    expect(mailConfigurationWarning()).toBeNull();
  });

  it("says plainly that console mode delivers nothing", () => {
    process.env.EMAIL_PROVIDER = "console";
    process.env.EMAIL_API_KEY = "";
    const warning = mailConfigurationWarning();
    expect(warning).toContain("console mode");
    // The reader has to be told what to do, not only what is wrong.
    expect(warning).toContain("EMAIL_PROVIDER=resend");
  });

  it("treats a missing provider as console mode, because that is what it is", () => {
    delete process.env.EMAIL_PROVIDER;
    delete process.env.EMAIL_API_KEY;
    expect(mailConfigurationWarning()).toContain("console mode");
  });

  it("names the missing key when a provider is chosen but no key is given", () => {
    // The most likely real mistake: EMAIL_PROVIDER set to resend, EMAIL_API_KEY left out.
    process.env.EMAIL_PROVIDER = "resend";
    process.env.EMAIL_API_KEY = "";
    expect(mailConfigurationWarning()).toContain("EMAIL_API_KEY");
  });

  it("treats a whitespace only key as missing", () => {
    // Hosts happily store an empty string, and a stray space looks configured to a human
    // reading the dashboard.
    process.env.EMAIL_PROVIDER = "resend";
    process.env.EMAIL_API_KEY = "   ";
    expect(mailConfigurationWarning()).toContain("EMAIL_API_KEY");
  });

  it("is case insensitive about the provider name", () => {
    process.env.EMAIL_PROVIDER = "RESEND";
    process.env.EMAIL_API_KEY = "re_live_something";
    expect(mailConfigurationWarning()).toBeNull();
  });
});

describe("cors origin warning", () => {
  it("rejects a wildcard, which cannot carry credentials", () => {
    expect(corsOriginWarning({ CORS_ORIGIN: "*" })).toContain('"*"');
  });

  it("says nothing when an exact origin is set", () => {
    expect(corsOriginWarning({ CORS_ORIGIN: "https://kazios.pages.dev" })).toBeNull();
  });
});

describe("production environment", () => {
  const complete = {
    NODE_ENV: "production",
    DATABASE_URL: "postgresql://x/y",
    SESSION_SECRET: "s".repeat(32),
    JWT_SECRET: "j".repeat(32),
    CORS_ORIGIN: "https://kazios.pages.dev",
  };

  it("passes when everything required is present", () => {
    expect(productionEnvProblems({ ...complete } as NodeJS.ProcessEnv)).toEqual([]);
  });

  it("stays out of the way outside production", () => {
    // A developer machine with no secrets is a normal place to be.
    expect(productionEnvProblems({} as NodeJS.ProcessEnv)).toEqual([]);
  });

  it("names every missing variable rather than only the first", () => {
    const problems = productionEnvProblems({ NODE_ENV: "production" } as NodeJS.ProcessEnv);
    expect(problems.length).toBeGreaterThan(1);
  });
});
