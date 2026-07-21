import { sql } from "./_db.js";
import { wrap } from "./_wrap.js";
import { requireAuth } from "./_auth.js";
import { logAct } from "./_log.js";

// 브라우저에서 일어난 오류 보고용 액션 화이트리스트 (전사·요약은 브라우저→Gemini 직행이라
// 서버가 모름 — 실패 시 브라우저가 여기로 보고해야 관리자가 원인을 추적할 수 있다)
const CLIENT_ACTIONS = new Set(["transcribe_error", "summarize_error", "client_error"]);

// POST /api/log { action, detail } → 클라이언트 오류 보고 (로그인 사용자)
// GET  /api/log?email=&limit=     → 활동 로그 조회 (관리자 전용)
export default wrap(async function handler(req, res) {
  const userId = requireAuth(req, res);
  if (!userId) return;

  if (req.method === "POST") {
    const action = String(req.body?.action ?? "");
    if (!CLIENT_ACTIONS.has(action)) return res.status(400).json({ error: "허용되지 않는 액션입니다." });
    await logAct(userId, action, req.body?.detail);
    return res.status(200).json({ ok: true });
  }

  if (req.method !== "GET") return res.status(405).json({ error: "GET/POST only" });

  const [me] = await sql`SELECT is_admin FROM users WHERE id = ${userId}`;
  if (!me?.is_admin) return res.status(403).json({ error: "관리자만 조회할 수 있습니다." });

  const email = String(req.query.email ?? "").trim();
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
  const rows = await sql`
    SELECT l.id, l.action, l.detail, l.created_at, u.email
    FROM activity_log l LEFT JOIN users u ON u.id = l.user_id
    ${email ? sql`WHERE u.email ILIKE ${"%" + email + "%"}` : sql``}
    ORDER BY l.id DESC LIMIT ${limit}`;
  res.status(200).json(rows);
});
