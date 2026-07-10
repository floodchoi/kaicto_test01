import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // 로컬 개발은 `vercel dev` 사용 (프론트+API 함께 구동). vite 단독 실행 시 아래 프록시 사용.
  server: {
    proxy: { "/api": "http://localhost:3001" },
  },
});
