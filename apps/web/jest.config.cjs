/**
 * Jest configuration for the React app.
 *
 * jsdom because the code under test renders components, and the setup file installs the
 * matchers and browser APIs jsdom does not provide.
 */
module.exports = {
  // The ts-jest preset is not used. Presets are resolved relative to this config, and in
  // an npm workspace the transform lives in the hoisted root node_modules one directory up.
  // Declaring it directly avoids that lookup and works the same whether or not npm gave
  // this package its own copy of ts-jest.
  testEnvironment: "jsdom",
  rootDir: ".",
  roots: ["<rootDir>/src"],
  // Both shapes are listed so `test:unit` and `test:integration` can select between them.
  testMatch: ["**/*.test.ts", "**/*.test.tsx", "**/*.integration.ts", "**/*.integration.tsx"],
  moduleFileExtensions: ["ts", "tsx", "js", "jsx", "json"],
  moduleNameMapper: {
    "\\.(css|less|scss|sass)$": "<rootDir>/jest.style-mock.cjs",
    "^@/(.*)$": "<rootDir>/src/$1",
    "^@kazios/(.*)$": "<rootDir>/../../packages/$1/src/index.ts",
  },
  transform: {
    "^.+\\.tsx?$": [
      require.resolve("ts-jest"),
      { diagnostics: false, tsconfig: { jsx: "react-jsx" } },
    ],
  },
  setupFilesAfterEnv: ["<rootDir>/jest.setup.ts"],
  collectCoverageFrom: ["src/**/*.{ts,tsx}", "!src/**/*.d.ts", "!src/main.tsx"],
  // See the API config: an empty package is not a failure, a deleted suite is.
  passWithNoTests: true,
};