import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Model APIs (e.g. 云雾) usually block direct browser calls (CORS), so the dev
// server proxies /llm/* to the configured provider. The app calls the
// same-origin path "/llm/v1"; the user still supplies their own key.
// Override the target with VITE_LLM_TARGET.
const LLM_TARGET = process.env.VITE_LLM_TARGET ?? "https://yunwu.ai";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/llm": {
        target: LLM_TARGET,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/llm/, ""),
      },
    },
  },
});
