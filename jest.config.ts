import type { Config } from "jest";

const config: Config = {
  testEnvironment: "node",
  roots: ["<rootDir>/src"],
  testMatch: ["**/*.spec.ts"],
  moduleNameMapper: {
    "^@/types$": "<rootDir>/src/types.ts",
    "^@/(.*)$": "<rootDir>/src/$1",
    "^@tests/(.*)$": "<rootDir>/tests/$1",
  },
  setupFiles: ["<rootDir>/tests/setup.ts"],
  transform: {
    // Include .js so ts-jest can down-level ESM-only deps (jose) to CJS.
    "^.+\\.[tj]sx?$": [
      "ts-jest",
      {
        tsconfig: "tsconfig.test.json",
      },
    ],
  },
  // jose ships ESM-only; let it through the transform above instead of being
  // skipped as a node_modules dep.
  transformIgnorePatterns: ["/node_modules/(?!jose/)"],
  collectCoverageFrom: [
    "src/domains/**/services/*.service.ts",
    "src/packages/**/*.ts",
    "!src/packages/**/index.ts",
    "!**/*.spec.ts",
    "!**/*.d.ts",
  ],
  coverageReporters: ["text", "text-summary", "json-summary", "lcov"],
  coverageDirectory: "coverage",
  clearMocks: true,
  restoreMocks: true,
};

export default config;
