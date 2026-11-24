// @ts-check
import antfu from "@antfu/eslint-config";

import autoImports from "./.wxt/eslint-auto-imports.mjs";

export default antfu(
  {
    gitignore: true,
    typescript: { tsconfigPath: "tsconfig.json" },
    react: true,
    vue: false,
    test: false,
    formatters: true,
    stylistic: {
      semi: true,
      indent: 2,
      quotes: "double",
    },
    ignores: [
      ".wxt/**",
      ".output/**",
      ".vscode/**",
      "**/fixtures/**",
      "src/components/ui/**",
      "components.json",
      "package.json",
      "pnpm-lock.yaml",
    ],
  },
  autoImports,
  {
    rules: {
      "style/jsx-max-props-per-line": ["error", { maximum: { single: 2, multi: 1 } }],
      "ts/no-redeclare": "off",
      "ts/consistent-type-definitions": ["error", "type"],
      "no-console": "warn",
      "antfu/no-top-level-await": "off",
      "node/prefer-global/process": "off",
      "node/no-process-env": "error",
      "perfectionist/sort-imports": ["error", { tsconfig: { rootDir: import.meta.dirname } }],
      "unicorn/filename-case": ["error", { case: "kebabCase", ignore: ["^README\\.md$"] }],
    },
  },
  {
    files: ["**/*.{js,cjs,mjs,jsx}", "**/*.md/**"],
    rules: {
      "react/no-implicit-key": "off",
    },
  },
  {
    files: ["entrypoints/sidepanel/**/*.tsx"],
    rules: {
      "unicorn/filename-case": ["error", { cases: { kebabCase: true, pascalCase: true } }],
    },
  },
  {
    files: ["tests/smoke-extension.mjs"],
    rules: {
      "node/no-process-env": "off",
    },
  },
);
