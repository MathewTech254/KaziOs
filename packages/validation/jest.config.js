/**
 * Jest configuration for the shared validation package.
 *
 * These schemas are the first line of defence for every write in the system, so they
 * are tested directly rather than only through the routes that happen to use them.
 */
module.exports = {
  // The ts-jest preset is not used. Presets are resolved relative to this file, and in
  // an npm workspace the transform lives in the hoisted root node_modules one directory
  // up. Naming it directly avoids that lookup and behaves the same whether or not npm
  // gave this package its own copy.
  testEnvironment: "node",
  rootDir: ".",
  roots: ["<rootDir>/src"],
  testMatch: ["**/*.test.ts", "**/*.integration.ts"],
  moduleFileExtensions: ["ts", "js", "json"],
  transform: {
    "^.+\\.ts$": [require.resolve("ts-jest"), { diagnostics: false }],
  },
  collectCoverageFrom: ["src/**/*.ts", "!src/**/*.d.ts", "!src/**/*.test.ts"],
};