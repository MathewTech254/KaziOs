/**
 * Jest configuration for @kazios/worker.
 *
 * Runs the package's own tests in isolation, with the shared workspaces mapped to
 * source so a change in one is picked up without a separate build step.
 */
module.exports = {
  // The ts-jest preset is not used here.
  //
  // Presets are resolved by Jest relative to this file, and in an npm workspace the
  // transform lives in the hoisted root node_modules, one directory above. Declaring
  // the transform directly avoids that lookup entirely and works the same whether or
  // not npm gave this package a local copy of ts-jest.
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
  // An empty package is not a failure; a suite that has been deleted still is.
  passWithNoTests: true,
};