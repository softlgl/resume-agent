import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    allowedHosts: true,
    proxy: {
      "/auth": "http://localhost:4000",
      "/resumes": "http://localhost:4000",
      "/export": "http://localhost:4000",
      "/health": "http://localhost:4000",
    },
  },
});
