import { readFileSync } from "node:fs";
import { sql } from "./_db.js";
import { wrap } from "./_wrap.js";
import { requireAuth, ADMIN_EMAIL } from "./_auth.js";

// POST /api/migrate — 관리자 전용. migrate.sql을 그대로 실행해 어떤 버전의 DB든
// 최신 스키마로 맞춘다(멱등). 앱 업데이트 후 "column … does not exist"가 나면
// 화면의 [마이그레이션 실행] 버튼이 이 엔드포인트를 호출한다.
export default wrap(async function handler(req, res) {
  const userId = requireAuth(req, res);
  if (!userId) return;
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  // SELECT * — 구버전 DB에 is_admin 컬럼이 없어도 이메일로 초기 관리자를 식별
  const [u] = await sql`SELECT * FROM users WHERE id = ${userId}`;
  if (!u || (!u.is_admin && u.email !== ADMIN_EMAIL))
    return res.status(403).json({ error: "관리자만 실행할 수 있습니다." });

  const text = readFileSync(new URL("../migrate.sql", import.meta.url), "utf8");
  await sql.unsafe(text);
  const { logAct } = await import("./_log.js"); // 마이그레이션 후에야 테이블이 생길 수 있어 지연 로드
  await logAct(userId, "migrate_run");
  res.status(200).json({ ok: true });
});
