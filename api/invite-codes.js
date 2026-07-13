import { randomBytes } from "node:crypto";
import { sql } from "./_db.js";
import { wrap } from "./_wrap.js";
import { requireAuth } from "./_auth.js";

// 초대 코드 관리 (관리자 전용)
// GET    /api/invite-codes → 목록 (사용량 포함)
// POST   /api/invite-codes { code?, max_uses } → 생성 (code 비우면 자동 생성)
// DELETE /api/invite-codes { id } → 삭제 (이미 가입한 회원에는 영향 없음)
export default wrap(async function handler(req, res) {
  const userId = requireAuth(req, res);
  if (!userId) return;
  const [me] = await sql`SELECT is_admin FROM users WHERE id = ${userId}`;
  if (!me?.is_admin) return res.status(403).json({ error: "관리자만 사용할 수 있습니다." });

  if (req.method === "GET") {
    const rows = await sql`
      SELECT id, code, max_uses, used_count, created_at
      FROM invite_codes ORDER BY created_at DESC`;
    return res.status(200).json(rows);
  }

  if (req.method === "POST") {
    const code = String(req.body?.code ?? "").trim() || randomBytes(4).toString("hex");
    const maxUses = Number(req.body?.max_uses);
    if (code.length > 100) return res.status(400).json({ error: "코드가 너무 깁니다 (최대 100자)." });
    if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 10000)
      return res.status(400).json({ error: "최대 사용 횟수는 1~10000 사이여야 합니다." });

    const [row] = await sql`
      INSERT INTO invite_codes (code, max_uses)
      VALUES (${code}, ${maxUses})
      ON CONFLICT (code) DO NOTHING
      RETURNING id, code, max_uses, used_count`;
    if (!row) return res.status(409).json({ error: "이미 존재하는 코드입니다." });
    return res.status(200).json(row);
  }

  if (req.method === "DELETE") {
    const [row] = await sql`
      DELETE FROM invite_codes WHERE id = ${Number(req.body?.id)} RETURNING id, code`;
    if (!row) return res.status(404).json({ error: "코드를 찾을 수 없습니다." });
    return res.status(200).json(row);
  }

  res.status(405).json({ error: "GET/POST/DELETE only" });
});
