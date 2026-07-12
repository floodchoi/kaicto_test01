import { sql } from "./_db.js";
import { wrap } from "./_wrap.js";
import { requireAuth } from "./_auth.js";

// GET    /api/projects → 내 프로젝트 + 공유 프로젝트
// POST   /api/projects { name, shared? } → 생성 (shared는 관리자만)
// DELETE /api/projects { projectId } → 삭제 (개인=소유자, 공유=관리자) — 회의록은 "프로젝트 없음"으로
export default wrap(async function handler(req, res) {
  const userId = requireAuth(req, res);
  if (!userId) return;

  if (req.method === "GET") {
    const rows = await sql`
      SELECT p.id, p.name, p.is_shared, (p.owner_id = ${userId}) AS is_mine,
             (SELECT count(*)::int FROM meetings m
               WHERE m.project_id = p.id
                 AND (m.user_id = ${userId} OR m.visibility = 'workspace')) AS meeting_count
      FROM projects p
      WHERE p.owner_id = ${userId} OR p.is_shared = true
      ORDER BY p.is_shared DESC, p.name`;
    return res.status(200).json(rows);
  }

  if (req.method === "POST") {
    const name = String(req.body?.name ?? "").trim();
    const shared = !!req.body?.shared;
    if (!name || name.length > 100)
      return res.status(400).json({ error: "프로젝트 이름을 1~100자로 입력해주세요." });
    if (shared) {
      const [me] = await sql`SELECT is_admin FROM users WHERE id = ${userId}`;
      if (!me?.is_admin)
        return res.status(403).json({ error: "공유 프로젝트는 관리자만 만들 수 있습니다." });
    }
    const [row] = await sql`
      INSERT INTO projects (name, owner_id, is_shared)
      VALUES (${name}, ${userId}, ${shared})
      RETURNING id, name, is_shared`;
    return res.status(200).json(row);
  }

  if (req.method === "DELETE") {
    const projectId = Number(req.body?.projectId);
    const [me] = await sql`SELECT is_admin FROM users WHERE id = ${userId}`;
    // 개인 프로젝트는 소유자만, 공유 프로젝트는 관리자만 삭제 가능
    const [row] = await sql`
      DELETE FROM projects
      WHERE id = ${projectId}
        AND ((is_shared = false AND owner_id = ${userId}) OR (is_shared = true AND ${!!me?.is_admin}))
      RETURNING id, name`;
    if (!row) return res.status(404).json({ error: "삭제할 수 없는 프로젝트입니다." });
    return res.status(200).json(row);
  }

  res.status(405).json({ error: "GET/POST/DELETE only" });
});
