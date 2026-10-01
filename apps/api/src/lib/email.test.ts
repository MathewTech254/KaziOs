import { loadConfig } from "@kazios/config";
import {
  checkMailConfiguration,
  isEmailConfigured,
  passwordChangedEmail,
  passwordResetEmail,
  resetWindowMinutes,
  sendMail,
  welcomeEmail,
} from "./email";

/**
 * Transactional email is the one part of sign-in a user only notices when it is broken,
 * and it cannot be exercised by hand without a live provider. These tests pin the
 * behaviour that makes the reset journey safe and completable: the link really is in the
 * message, the message really is handed to the mailer, and a dead provider never takes a
 * sale or a sign-up down with it.
 */
jest.mock("@kazios/config", () => ({ loadConfig: jest.fn() }));

const configMock = loadConfig as unknown as jest.Mock;

interface EmailCfg {
  provider: string;
  apiKey: string;
  from: string;
  fromName: string;
}

function setEmailConfig(overrides: Partial<EmailCfg> = {}) {
  configMock.mockReturnValue({
    email: {
      provider: "console",
      apiKey: "",
      from: "no-reply@kazios.test",
      fromName: "KaziOS",
      ...overrides,
    },
  });
}

const originalAppUrl = process.env.APP_URL;
let fetchMock: jest.Mock;
let logSpy: jest.SpyInstance;
let errorSpy: jest.SpyInstance;

beforeEach(() => {
  setEmailConfig();
  fetchMock = jest.fn();
  (global as unknown as { fetch: jest.Mock }).fetch = fetchMock;
  // Silenced rather than left alone: a failing send logs loudly, and a passing test run
  // should not print a wall of mail previews.
  logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
  errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
});

afterAll(() => {
  process.env.APP_URL = originalAppUrl;
});

describe("reset window", () => {
  it("is short, because a link sitting in an inbox is public", () => {
    // A reset link that stays valid for a day is a standing account takeover risk.
    expect(resetWindowMinutes()).toBe(15);
  });
});

describe("passwordResetEmail", () => {
  beforeEach(() => {
    process.env.APP_URL = "https://app.kazios.test/";
  });

  it("sends to the address that asked for it", () => {
    expect(passwordResetEmail("amina@highlands.test", "Amina", "tok").to).toBe(
      "amina@highlands.test"
    );
  });

  it("puts a working reset link in both the html and the plain text", () => {
    // A link that exists in only one part is the classic bug: html clients get it, plain
    // text clients and mail security scanners do not.
    const mail = passwordResetEmail("amina@highlands.test", "Amina", "abc123");
    const expected = "https://app.kazios.test/reset-password?token=abc123";
    expect(mail.html).toContain(expected);
    expect(mail.text).toContain(expected);
  });

  it("strips trailing slashes so the link never doubles up", () => {
    process.env.APP_URL = "https://app.kazios.test///";
    expect(passwordResetEmail("a@b.test", "A", "t").text).toContain(
      "https://app.kazios.test/reset-password?token=t"
    );
  });

  it("encodes the token so it survives the query string", () => {
    const mail = passwordResetEmail("a@b.test", "A", "a b&c=d");
    expect(mail.text).toContain("token=a%20b%26c%3Dd");
    expect(mail.text).not.toContain("token=a b&c=d");
  });

  it("tells the user the window is short, in the message they will read", () => {
    expect(passwordResetEmail("a@b.test", "A", "t").text).toContain("15 minutes");
  });
});

describe("passwordChangedEmail", () => {
  it("carries no reset link, so a leaked copy cannot be replayed", () => {
    const mail = passwordChangedEmail("amina@highlands.test", "Amina");
    expect(mail.text).not.toContain("reset-password?token=");
    expect(mail.html).not.toContain("reset-password?token=");
  });

  it("tells the user other sessions were ended", () => {
    expect(passwordChangedEmail("a@b.test", "A").text).toContain("signed out");
  });

  describe("isEmailConfigured", () => {
    it("is false in console mode, which delivers nothing", () => {
      setEmailConfig({ provider: "console", apiKey: "re_123" });
      expect(isEmailConfigured()).toBe(false);
    });

    it("is false when a provider is named but no key is set", () => {
      // A half configured provider is the most common reason mail silently never arrives.
      setEmailConfig({ provider: "resend", apiKey: "" });
      expect(isEmailConfigured()).toBe(false);
    });

    it("is true once a provider and key are both present", () => {
      setEmailConfig({ provider: "resend", apiKey: "re_123" });
      expect(isEmailConfigured()).toBe(true);
    });
  });

  describe("sendMail", () => {
    const mail = { to: "a@b.test", subject: "Hi", html: "<p>hi</p>", text: "hi" };

    it("never throws and reports failure when no provider is configured", async () => {
      setEmailConfig();
      await expect(sendMail(mail)).resolves.toBe(false);
    });

    it("prints the message in console mode so the flow is still completable", async () => {
      // This is the only way a developer can complete a reset locally.
      setEmailConfig();
      await sendMail(passwordResetEmail("a@b.test", "A", "tok-xyz"));
      const printed = logSpy.mock.calls.map(c => c.join(" ")).join("\n");
      expect(printed).toContain("token=tok-xyz");
    });

    it("returns true when the provider accepts the message", async () => {
      setEmailConfig({ provider: "resend", apiKey: "re_123" });
      fetchMock.mockResolvedValue({ ok: true, status: 200 });
      await expect(sendMail(mail)).resolves.toBe(true);
    });

    it("does not throw when the provider rejects the message", async () => {
      setEmailConfig({ provider: "resend", apiKey: "re_123" });
      fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => "boom" });
      await expect(sendMail(mail)).resolves.toBe(false);
    });

    it("does not throw when the network is down", async () => {
      // A failed email must never roll back the sale or sign-up that triggered it.
      setEmailConfig({ provider: "resend", apiKey: "re_123" });
      fetchMock.mockRejectedValue(new Error("ENOTFOUND"));
      await expect(sendMail(mail)).resolves.toBe(false);
      expect(errorSpy).toHaveBeenCalled();
    });

    it("explains a rejected key instead of letting a console line look delivered", async () => {
      setEmailConfig({ provider: "resend", apiKey: "re_dead" });
      fetchMock.mockResolvedValue({ ok: false, status: 401, text: async () => "unauthorized" });
      await sendMail(mail);
      const logged = errorSpy.mock.calls.map(c => c.join(" ")).join("\n");
      expect(logged).toContain("resend.com/api-keys");
    });

    it("swaps the placeholder domain for one Resend always allows", async () => {
      // `no-reply@kazios.test` is not a verified domain, so sending to it fails for every
      // real user. The placeholder is replaced rather than trusted.
      setEmailConfig({ provider: "resend", apiKey: "re_123", from: "no-reply@kazios.test" });
      fetchMock.mockResolvedValue({ ok: true, status: 200 });
      await sendMail(mail);
      const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      expect(body.from).toBe("KaziOS <onboarding@resend.dev>");
    });

    it("keeps a real sender address and carries the name", async () => {
      setEmailConfig({
        provider: "resend",
        apiKey: "re_123",
        from: "billing@highlands.co.ke",
        fromName: "Highlands",
      });
      fetchMock.mockResolvedValue({ ok: true, status: 200 });
      await sendMail(mail);
      const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      expect(body.from).toBe("Highlands <billing@highlands.co.ke>");
      expect(body.to).toEqual(["a@b.test"]);
    });
  });

  describe("checkMailConfiguration", () => {
    it("says plainly that console mode delivers nothing", async () => {
      const check = await checkMailConfiguration();
      expect(check.ok).toBe(false);
      expect(check.detail).toContain("console mode");
    });

    it("names the missing key", async () => {
      setEmailConfig({ provider: "resend", apiKey: "" });
      const check = await checkMailConfiguration();
      expect(check.ok).toBe(false);
      expect(check.detail).toContain("EMAIL_API_KEY");
    });

    it("reports a revoked key rather than a generic failure", async () => {
      setEmailConfig({ provider: "resend", apiKey: "re_dead" });
      fetchMock.mockResolvedValue({ status: 401 });
      const check = await checkMailConfiguration();
      expect(check.ok).toBe(false);
      expect(check.detail).toContain("rejected");
    });

    it("confirms a working key", async () => {
      setEmailConfig({ provider: "resend", apiKey: "re_123" });
      fetchMock.mockResolvedValue({ status: 200 });
      const check = await checkMailConfiguration();
      expect(check.ok).toBe(true);
    });

    it("reports a network failure without throwing", async () => {
      setEmailConfig({ provider: "resend", apiKey: "re_123" });
      fetchMock.mockRejectedValue(new Error("offline"));
      await expect(checkMailConfiguration()).resolves.toMatchObject({ ok: false });
    });
  });
});

describe("welcomeEmail", () => {
  it("names the organization so a shared inbox can tell accounts apart", () => {
    const mail = welcomeEmail("a@b.test", "Amina", "Highlands Provisions");
    expect(mail.subject).toContain("Highlands Provisions");
    expect(mail.text).toContain("Highlands Provisions");
  });
});
