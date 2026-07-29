// ESLint 9 flat config.
//
// `eslint-config-next` is still published in eslintrc format, so it is bridged
// through FlatCompat. Everything else is expressed natively below.

import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __dirname = dirname(fileURLToPath(import.meta.url));
const compat = new FlatCompat({ baseDirectory: __dirname });

export default [
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      "dist/**",
      "coverage/**",
      "applications/**",
      "logs/**",
      "prisma/migrations/**",
      // Browser-extension sources are plain ES5-ish scripts with their own globals.
      "extension/**",
      "next-env.d.ts",
      "*.config.js",
      "*.config.mjs",
    ],
  },

  ...compat.extends("next/core-web-vitals", "next/typescript"),

  {
    rules: {
      // Unused code is a review smell — flag it, but allow the `_`-prefix escape
      // hatch for deliberately-ignored destructured values and catch bindings.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
      // `any` defeats the point of strict mode; warn rather than error so it
      // doesn't block work on the pre-existing surface.
      "@typescript-eslint/no-explicit-any": "warn",
      // Application logging goes through Logger (src/lib/logging/logger.ts).
      // console.warn/error stay available for genuine startup failures.
      "no-console": ["warn", { allow: ["warn", "error"] }],
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-var": "error",
      "prefer-const": "error",
      "no-throw-literal": "error",
    },
  },

  {
    // CLI scripts and the logger are the places where writing to stdout IS the job.
    files: [
      "scripts/**/*.ts",
      "prisma/seed.ts",
      "src/lib/logging/logger.ts",
      "src/lib/agent/notify.ts",
    ],
    rules: { "no-console": "off" },
  },

  {
    files: ["test/**/*.ts", "src/**/__tests__/**/*.ts", "**/*.test.ts"],
    rules: {
      "no-console": "off",
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
];
