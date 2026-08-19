import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  root: "src/web",
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: "fluent-ui",
              test: /node_modules[\\/]@fluentui[\\/]/,
              priority: 2,
            },
            {
              name: "react",
              test: /node_modules[\\/](?:react|react-dom)[\\/]/,
              priority: 1,
            },
          ],
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:4310",
      "/health": "http://127.0.0.1:4310",
    },
  },
});
