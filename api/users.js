import { sql } from "./_db.js";
import { wrap } from "./_wrap.js";
import { requireAuth } from "./_auth.js";

// GET /api/users?q=... → 이메일 검색 (프로젝트 멤버 지정용). 로그인 필수, 2자 이상.
export default wrap(async function handler(req, res) {
  const userId = requireAuth(req, res);
  if (!userId) return;
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  const q = String(req.query.q ?? "").trim();
  if (q.length < 2) return res.status(200).json([]);

  const rows = await sql`
    SELECT id, email FROM users
    WHERE approved = true AND id != ${userId} AND email ILIKE ${"%" + q + "%"}
    ORDER BY email LIMIT 8`;
  res.status(200).json(rows);
});
