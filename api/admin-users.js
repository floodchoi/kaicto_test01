import { sql } from "./_db.js";
import { wrap } from "./_wrap.js";
import { requireAuth } from "./_auth.js";

// 관리자 전용 회원 관리
// GET    /api/admin-users → 회원 목록
// PATCH  /api/admin-users { userId, can_use_admin_key } → 관리자 키 사용 권한 지정
// DELETE /api/admin-users { userId } → 회원 삭제 (본인·관리자 제외, 회의록도 함께 삭제)
export default wrap(async function handler(req, res) {
  const userId = requireAuth(req, res);
  if (!userId) return;

  const [me] = await sql`SELECT is_admin FROM users WHERE id = ${userId}`;
  if (!me?.is_admin) return res.status(403).json({ error: "관리자만 사용할 수 있습니다." });

  if (req.method === "GET") {
    const rows = await sql`
      SELECT u.id, u.email, u.is_admin, u.approved, u.can_use_admin_key, u.created_at, u.last_seen_at,
             (u.gemini_key_enc IS NOT NULL) AS has_key,
             (SELECT count(*)::int FROM meetings m WHERE m.user_id = u.id) AS meeting_count
      FROM users u ORDER BY u.approved ASC, u.id`;
    return res.status(200).json(rows);
  }

  // { userId, approved? , can_use_admin_key? } — 준 필드만 변경
  if (req.method === "PATCH") {
    const { userId: targetId, can_use_admin_key, approved } = req.body ?? {};
    const [row] = await sql`
      UPDATE users SET
        can_use_admin_key = COALESCE(${can_use_admin_key ?? null}, can_use_admin_key),
        approved          = COALESCE(${approved ?? null}, approved)
      WHERE id = ${Number(targetId)} AND is_admin = false
      RETURNING id, email, approved, can_use_admin_key`;
    if (!row) return res.status(404).json({ error: "대상 회원을 찾을 수 없습니다 (관리자는 변경 불가)." });
    return res.status(200).json(row);
  }

  if (req.method === "DELETE") {
    const targetId = Number(req.body?.userId);
    if (targetId === userId) return res.status(400).json({ error: "본인 계정은 삭제할 수 없습니다." });
    const [row] = await sql`
      DELETE FROM users WHERE id = ${targetId} AND is_admin = false
      RETURNING id, email`;
    if (!row) return res.status(404).json({ error: "대상 회원을 찾을 수 없습니다 (관리자는 삭제 불가)." });
    return res.status(200).json(row);
  }

  res.status(405).json({ error: "GET/PATCH/DELETE only" });
});
