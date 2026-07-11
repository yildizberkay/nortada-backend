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
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        tsconfig: "tsconfig.test.json",
      },
    ],
  },
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
