import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // 로컬 개발은 `vercel dev` 사용 (프론트+API 함께 구동). vite 단독 실행 시 아래 프록시 사용.
  server: {
    // API_PORT로 백엔드 포트 변경 가능 (예: 3001이 점유됐을 때 API_PORT=3103)
    proxy: { "/api": `http://localhost:${process.env.API_PORT || 3001}` },
  },
});
