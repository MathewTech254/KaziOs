/**
 * Jest configuration for the API.
 *
 * ts-jest compiles the same TypeScript the build does, so a test that passes is a test
 * against the real code rather than a transpiled approximation. `isolatedModules` keeps
 * the run fast; type errors are caught by `npm run typecheck`, which is the job for
 * them.
 */
module.exports = {
  // The ts-jest preset is not used. Presets are resolved relative to this config, and in
  // an npm workspace the transform lives in the hoisted root node_modules one directory up.
  // Declaring it directly avoids that lookup and works the same whether or not npm gave
  // this package its own copy of ts-jest.
  testEnvironment: "node",
  rootDir: ".",
  roots: ["<rootDir>/src", "<rootDir>/scripts"],
  testMatch: ["**/*.test.ts", "**/*.integration.ts"],
  moduleFileExtensions: ["ts", "tsx", "js", "jsx", "json", "node"],
  // The workspace packages are consumed as built JavaScript, matching how the app runs.
  moduleNameMapper: {
    "^@kazios/(.*)$": "<rootDir>/../../packages/$1/src/index.ts",
  },
  transform: {
    // isolatedModules moves into tsconfig, where TypeScript wants it; declaring it here
    // as well is deprecated and will be removed in ts-jest 30.
    "^.+\\.ts$": [require.resolve("ts-jest"), { diagnostics: false }],
  },
  collectCoverageFrom: [
    "src/**/*.ts",
    // Route wiring is mostly declarative; measuring it produces noise rather than signal.
    "!src/index.ts",
    "!src/**/*.d.ts",
  ],
  // Long enough for the bcrypt and database work these tests do, short enough that a
  // hung test still fails inside a normal wait.
  testTimeout: 30000,
  clearMocks: true,
  // The gate is only meaningful once there is something to run. This keeps the build
  // green on a package that has no tests yet, without hiding a suite that has been
  // deleted by accident: those still fail.
  passWithNoTests: true,
};