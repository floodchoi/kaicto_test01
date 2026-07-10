import postgres from "postgres";

const url = process.env.DATABASE_URL ?? "";

// 로컬 Postgres는 SSL 없음, 원격(Supabase/Neon 등)은 SSL 필요 → 호스트로 자동 판별.
let host = "";
try {
  host = new URL(url).hostname;
} catch {
  /* 파싱 실패 시 원격으로 간주(SSL 적용) */
}
const isLocal = host === "localhost" || host === "127.0.0.1" || host === "::1";

// - prepare:false : Supabase 트랜잭션 풀러(6543)·Neon 풀러는 prepared statement 미지원 → 필수
// - max:1 + idle_timeout : 서버리스 인스턴스당 커넥션 최소화
// - ssl:"require" : 원격은 SSL 강제(인증서 검증 없이 암호화). Supabase URL에 sslmode 없어도 동작.
export const sql = postgres(url, {
  prepare: false,
  max: 1,
  idle_timeout: 20,
  connect_timeout: 10,
  ssl: isLocal ? false : "require",
});
