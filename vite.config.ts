import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  root: "src",
  publicDir: resolve(__dirname, "public"),
  server: {
    port: 3000,
    proxy: {
      "/ws": {
        target: "ws://localhost:18800",
        ws: true,
      },
      "/api": {
        target: "http://localhost:18800",
        changeOrigin: true,
      },
    },
  },
  plugins: [
    {
      name: "rewrite-html-pages",
      configureServer(server) {
        server.middlewares.use((req, _res, next) => {
          if (req.url === "/admin") req.url = "/admin.html";
          if (req.url === "/logs") req.url = "/logs.html";
          next();
        });
      },
    },
  ],
  build: {
    outDir: resolve(__dirname, "dist"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, "src/index.html"),
        logs: resolve(__dirname, "src/logs.html"),
        admin: resolve(__dirname, "src/admin.html"),
      },
    },
  },
});
