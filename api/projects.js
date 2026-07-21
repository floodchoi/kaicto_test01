import { sql } from "./_db.js";
import { wrap } from "./_wrap.js";
import { requireAuth } from "./_auth.js";
import { logAct } from "./_log.js";

// GET    /api/projects → 내 프로젝트 + 공유 프로젝트 + 내가 멤버인 프로젝트 (멤버 목록 포함)
// POST   /api/projects { name, shared? } → 생성 (shared는 관리자만)
// PATCH  /api/projects { projectId, addUserId? | removeUserId? } → 멤버 지정/해제 (소유자·관리자)
// DELETE /api/projects { projectId } → 삭제 (개인=소유자, 공유=관리자) — 회의록은 "프로젝트 없음"으로
export default wrap(async function handler(req, res) {
  const userId = requireAuth(req, res);
  if (!userId) return;

  if (req.method === "GET") {
    const rows = await sql`
      SELECT p.id, p.name, p.is_shared, (p.owner_id = ${userId}) AS is_mine,
             EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = ${userId}) AS is_member,
             (SELECT count(*)::int FROM meetings m
               WHERE m.project_id = p.id
                 AND (m.user_id = ${userId} OR m.visibility = 'workspace' OR p.owner_id = ${userId}
                      OR EXISTS (SELECT 1 FROM project_members pm2
                                  WHERE pm2.project_id = p.id AND pm2.user_id = ${userId}))) AS meeting_count,
             (SELECT COALESCE(json_agg(json_build_object('id', u.id, 'email', u.email) ORDER BY u.email), '[]'::json)
                FROM project_members pm JOIN users u ON u.id = pm.user_id
               WHERE pm.project_id = p.id) AS members
      FROM projects p
      WHERE p.owner_id = ${userId} OR p.is_shared = true
         OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = ${userId})
      ORDER BY p.is_shared DESC, p.name`;
    return res.status(200).json(rows);
  }

  // 멤버 지정/해제 — 프로젝트 소유자 또는 (공유 프로젝트는) 관리자만
  if (req.method === "PATCH") {
    const projectId = Number(req.body?.projectId);
    const [me] = await sql`SELECT is_admin FROM users WHERE id = ${userId}`;
    const [p] = await sql`
      SELECT id, owner_id, is_shared FROM projects
      WHERE id = ${projectId} AND (owner_id = ${userId} OR (is_shared = true AND ${!!me?.is_admin}))`;
    if (!p) return res.status(403).json({ error: "이 프로젝트의 멤버를 관리할 권한이 없습니다." });

    const addUserId = Number(req.body?.addUserId);
    const removeUserId = Number(req.body?.removeUserId);
    if (Number.isInteger(addUserId) && addUserId > 0) {
      const [u] = await sql`SELECT id FROM users WHERE id = ${addUserId} AND approved = true`;
      if (!u) return res.status(404).json({ error: "해당 사용자를 찾을 수 없습니다." });
      await sql`
        INSERT INTO project_members (project_id, user_id)
        VALUES (${projectId}, ${addUserId}) ON CONFLICT DO NOTHING`;
      await logAct(userId, "member_add", `프로젝트 #${projectId} ← 사용자 #${addUserId}`);
    } else if (Number.isInteger(removeUserId) && removeUserId > 0) {
      await sql`DELETE FROM project_members WHERE project_id = ${projectId} AND user_id = ${removeUserId}`;
      await logAct(userId, "member_remove", `프로젝트 #${projectId} → 사용자 #${removeUserId}`);
    } else {
      return res.status(400).json({ error: "addUserId 또는 removeUserId가 필요합니다." });
    }
    return res.status(200).json({ ok: true });
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

  res.status(405).json({ error: "GET/POST/PATCH/DELETE only" });
});
