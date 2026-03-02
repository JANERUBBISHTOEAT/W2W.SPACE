import { FlatCompat } from "@eslint/eslintrc";
import js from "@eslint/js";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const compat = new FlatCompat({
  baseDirectory: __dirname,
  recommendedConfig: js.configs.recommended,
});
const legacyConfig = require("./.eslintrc.cjs");

export default [
  { ignores: ["node_modules/", "build/", ".cache/", ".env"] },
  ...compat.config(legacyConfig),
];
