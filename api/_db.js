import postgres from "postgres";

// Neon(프로덕션)·로컬 Postgres 모두 동작.
// - prepare:false : Neon 풀러(PgBouncer, 트랜잭션 모드)는 prepared statement 미지원 → 필수
// - max:1 + idle_timeout : 서버리스 인스턴스당 커넥션을 최소화 (Vercel에선 반드시 -pooler 엔드포인트 사용)
export const sql = postgres(process.env.DATABASE_URL, {
  prepare: false,
  max: 1,
  idle_timeout: 20,
  connect_timeout: 10,
});
