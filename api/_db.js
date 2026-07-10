import postgres from "postgres";

// 로컬 Postgres와 Neon 모두 동작. prepare:false는 Neon pooler 호환용.
export const sql = postgres(process.env.DATABASE_URL, { prepare: false });
