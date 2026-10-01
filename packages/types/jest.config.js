/**
 * Jest configuration for @kazios/types.
 *
 * Runs the package's own tests in isolation, with the shared workspaces mapped to
 * source so a change in one is picked up without a separate build step.
 */
module.exports = {
  testEnvironment: "node",
  rootDir: ".",
  roots: ["<rootDir>/src"],
  testMatch: ["**/*.test.ts", "**/*.integration.ts"],
  moduleFileExtensions: ["ts", "js", "json"],
  moduleNameMapper: {
    "^@kazios/(.*)$": "<rootDir>/../../packages/$1/src/index.ts",
  },
  transform: {
    "^.+\\.ts$": [require.resolve("ts-jest"), { diagnostics: false }],
  },
  collectCoverageFrom: ["src/**/*.ts", "!src/**/*.d.ts", "!src/**/*.test.ts"],
  // Passes while the package has no tests yet, so an empty package does not fail the
  // whole build before anyone has written anything for it.
  passWithNoTests: true,
};