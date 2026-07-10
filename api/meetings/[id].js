import { sql } from "../_db.js";
import { wrap } from "../_wrap.js";
import { requireAuth } from "../_auth.js";

export default wrap(async function handler(req, res) {
  const userId = requireAuth(req, res);
  if (!userId) return;

  const id = Number(req.query.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "invalid id" });

  if (req.method === "GET") {
    // 본인 것 또는 전체 공개(workspace)만 열람 가능
    const [meeting] = await sql`
      SELECT m.*, (m.user_id = ${userId}) AS is_owner, u.email AS owner_email
      FROM meetings m LEFT JOIN users u ON u.id = m.user_id
      WHERE m.id = ${id} AND (m.user_id = ${userId} OR m.visibility = 'workspace')`;
    if (!meeting) return res.status(404).json({ error: "not found" });
    const items = await sql`
      SELECT * FROM action_items WHERE meeting_id = ${id} ORDER BY id`;
    return res.status(200).json({ ...meeting, action_items: items });
  }

  if (req.method === "PATCH") {
    // 액션 아이템 완료 토글: { actionItemId, done } — 소유자만 (공개 열람자는 불가)
    const { actionItemId, done } = req.body ?? {};
    const [row] = await sql`
      UPDATE action_items SET done = ${!!done}
      WHERE id = ${actionItemId} AND meeting_id = ${id}
        AND EXISTS (SELECT 1 FROM meetings m WHERE m.id = ${id} AND m.user_id = ${userId})
      RETURNING *`;
    if (!row) return res.status(404).json({ error: "not found" });
    return res.status(200).json(row);
  }

  res.status(405).json({ error: "GET/PATCH only" });
});
