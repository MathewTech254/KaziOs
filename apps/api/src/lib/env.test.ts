import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { resolveEnvFiles } from "./env";

/**
 * The bug this file exists to prevent: a path built with a fixed number of ".." from
 * __dirname resolves to apps/api/ in the source layout and to apps/api/ in the compiled
 * layout too, so the repository root .env was never read and every integration that
 * lives only in the root file (M-PESA above all) silently went unconfigured.
 */
describe("env file resolution", () => {
  let root: string;
  let apiDir: string;
  let libDir: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "kazios-env-"));
    apiDir = path.join(root, "apps", "api");
    libDir = path.join(apiDir, "src", "lib");
    fs.mkdirSync(libDir, { recursive: true });
    // The workspace marker is what tells the walk where the repository root is.
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "kazios", workspaces: ["apps/*"] })
    );
    fs.writeFileSync(path.join(apiDir, "package.json"), JSON.stringify({ name: "api" }));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("finds the API's own .env and the repository root .env", () => {
    fs.writeFileSync(path.join(apiDir, ".env"), "DATABASE_URL=local\n");
    fs.writeFileSync(path.join(root, ".env"), "MPESA_CONSUMER_KEY=key\n");

    const files = resolveEnvFiles({}, root, libDir);

    expect(files).toContain(path.join(apiDir, ".env"));
    expect(files).toContain(path.join(root, ".env"));
  });

  it("puts the API's own .env first, so it wins per key", () => {
    fs.writeFileSync(path.join(apiDir, ".env"), "DATABASE_URL=local\n");
    fs.writeFileSync(path.join(root, ".env"), "DATABASE_URL=hosted\n");

    const files = resolveEnvFiles({}, root, libDir);

    // dotenv never overwrites, so file order is the precedence order.
    expect(files.indexOf(path.join(apiDir, ".env"))).toBeLessThan(
      files.indexOf(path.join(root, ".env"))
    );
  });

  it("still finds the root .env when the API has no .env of its own", () => {
    fs.writeFileSync(path.join(root, ".env"), "MPESA_CONSUMER_KEY=key\n");

    const files = resolveEnvFiles({}, root, libDir);

    expect(files).toContain(path.join(root, ".env"));
  });

  it("reads the root .env from the compiled layout too", () => {
    const distLib = path.join(apiDir, "dist", "lib");
    fs.mkdirSync(distLib, { recursive: true });
    fs.writeFileSync(path.join(apiDir, ".env"), "DATABASE_URL=local\n");
    fs.writeFileSync(path.join(root, ".env"), "MPESA_CONSUMER_KEY=key\n");

    const files = resolveEnvFiles({}, root, distLib);

    expect(files).toContain(path.join(apiDir, ".env"));
    expect(files).toContain(path.join(root, ".env"));
  });

  it("does not read the production file outside production", () => {
    fs.writeFileSync(path.join(apiDir, ".env.production"), "MPESA_CONSUMER_KEY=prod\n");

    const files = resolveEnvFiles({ NODE_ENV: "development" }, root, libDir);

    expect(files).not.toContain(path.join(apiDir, ".env.production"));
  });

  it("reads the production file in production", () => {
    fs.writeFileSync(path.join(apiDir, ".env.production"), "MPESA_CONSUMER_KEY=prod\n");

    const files = resolveEnvFiles({ NODE_ENV: "production" }, root, libDir);

    expect(files).toContain(path.join(apiDir, ".env.production"));
  });

  it("loads the production file first, so it can override the other files", () => {
    // The production file holds the hosted DATABASE_URL, which has to beat the
    // local one in apps/api/.env. dotenv keeps the first value it sees, so a
    // production file loaded last would be ignored rather than applied.
    fs.writeFileSync(path.join(apiDir, ".env.production"), "DATABASE_URL=hosted\n");
    fs.writeFileSync(path.join(apiDir, ".env"), "DATABASE_URL=local\n");
    fs.writeFileSync(path.join(root, ".env"), "MPESA_CONSUMER_KEY=key\n");

    const files = resolveEnvFiles({ NODE_ENV: "production" }, root, libDir);

    expect(files.indexOf(path.join(apiDir, ".env.production"))).toBeLessThan(
      files.indexOf(path.join(apiDir, ".env"))
    );
  });

  it("lets the production file override the repository root file too", () => {
    fs.writeFileSync(path.join(apiDir, ".env.production"), "MPESA_CONSUMER_KEY=prod\n");
    fs.writeFileSync(path.join(root, ".env"), "MPESA_CONSUMER_KEY=key\n");

    const files = resolveEnvFiles({ NODE_ENV: "production" }, root, libDir);

    expect(files.indexOf(path.join(apiDir, ".env.production"))).toBeLessThan(
      files.indexOf(path.join(root, ".env"))
    );
  });

  it("keeps the API's own .env ahead of the repository root file in production", () => {
    fs.writeFileSync(path.join(apiDir, ".env.production"), "SESSION_SECRET=prod\n");
    fs.writeFileSync(path.join(apiDir, ".env"), "DATABASE_URL=local\n");
    fs.writeFileSync(path.join(root, ".env"), "DATABASE_URL=hosted\n");

    const files = resolveEnvFiles({ NODE_ENV: "production" }, root, libDir);

    expect(fi 
      files.indexOf(path.join(root, ".env"))
    );
  });

  it("never lists the same file twice", () => {
    fs.writeFileSync(path.join(apiDir, ".env"), "DATABASE_URL=local\n");
    fs.writeFileSync(path.join(root, ".env"), "MPESA_CONSUMER_KEY=key\n");

    const files = resolveEnvFiles({ NODE_ENV: "production" }, root, libDir);

    expect(new Set(files).size).toBe(files.length);
  });
});