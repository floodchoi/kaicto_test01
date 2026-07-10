import { sql } from "./_db.js";
import { wrap } from "./_wrap.js";
import { requireAuth } from "./_auth.js";

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);

// GET /api/action-items?q=&from=&to= — 본인 회의록의 액션 아이템 전체
// (공개 회의록의 항목은 해당 회의록 상세에서 열람 — 여기는 내 할 일 관리 용도)
export default wrap(async function handler(req, res) {
  const userId = requireAuth(req, res);
  if (!userId) return;
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  const q = (req.query.q ?? "").trim();
  const from = (req.query.from ?? "").trim();
  const to = (req.query.to ?? "").trim();

  const rows = await sql`
    SELECT a.id, a.meeting_id, a.task, a.assignee, a.due_date, a.done,
           m.title AS meeting_title, m.created_at AS meeting_date
    FROM action_items a
    JOIN meetings m ON m.id = a.meeting_id
    WHERE m.user_id = ${userId}
    ${q ? sql`AND (a.task ILIKE ${"%" + q + "%"} OR a.assignee ILIKE ${"%" + q + "%"} OR m.title ILIKE ${"%" + q + "%"})` : sql``}
    ${isDate(from) ? sql`AND m.created_at >= ${from}::date` : sql``}
    ${isDate(to) ? sql`AND m.created_at < ${to}::date + 1` : sql``}
    ORDER BY a.done ASC, m.created_at DESC, a.id`;

  res.status(200).json(rows);
});
