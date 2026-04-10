// ESLint v9 flat config.
//
// Rule philosophy:
//   * Keep the strict @typescript-eslint "recommended" ruleset.
//   * Opt out of the handful of type-checked rules that are almost always
//     false positives in this codebase (the Node http/pino/minisearch
//     typings return a lot of `any`, and vitest's mocking patterns trip
//     `unbound-method`).
//   * Keep all the rules that catch real bugs: no-explicit-any,
//     no-unused-vars, prefer-const, eqeqeq, no-console, await-thenable,
//     prefer-promise-reject-errors, no-unnecessary-type-assertion.
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "**/*.cjs",
      "**/*.config.ts",
      "coverage/**",
      "templates/**",
    ],
  },
  js.configs.recommended,
  {
    files: ["src/**/*.ts", "test/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
        project: "./tsconfig.eslint.json",
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.node,
        ...globals.es2022,
        NodeJS: "readonly",
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      ...tsPlugin.configs["recommended-requiring-type-checking"].rules,

      // --- Errors we actually care about ---------------------------
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-console": "error",
      eqeqeq: ["error", "always"],
      "prefer-const": "error",

      // --- Soften noisy rules ---------------------------------------
      // These fire a lot on perfectly fine code (pino loggers return
      // their builder from method calls, chokidar/minisearch have
      // sparse types, commander.js action callbacks return Promises).
      "@typescript-eslint/consistent-type-imports": "warn",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/unbound-method": "off",
      "@typescript-eslint/no-misused-promises": "off",
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
      "@typescript-eslint/explicit-function-return-type": [
        "warn",
        { allowExpressions: true, allowTypedFunctionExpressions: true },
      ],
    },
  },
  {
    // Tests can use `console` for debug prints and often parse untyped
    // JSON blobs from tool results.
    files: ["test/**/*.ts"],
    rules: {
      "no-console": "off",
    },
  },
];
