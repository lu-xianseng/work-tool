import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri 开发服务器固定端口 1420，与 tauri.conf.json 的 devUrl 对应
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: "ws", host, port: 1421 }
      : undefined,
    watch: {
      // 不要监听 Rust 后端目录
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    // Tauri 使用 Chrome 的原生 ES 模块，不需要兼容性降级
    target: "esnext",
    minify: "esbuild",
    outDir: "dist",
  },
});
