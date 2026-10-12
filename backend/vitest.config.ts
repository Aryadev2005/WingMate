import { defineConfig } from "vitest/config";

// Test files share one Postgres database, so they run one after another.
export default defineConfig({ test: { fileParallelism: false } });
