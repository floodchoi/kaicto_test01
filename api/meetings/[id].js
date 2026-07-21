import { sql } from "../_db.js";
import { wrap } from "../_wrap.js";
import { requireAuth, encryptText, decryptText } from "../_auth.js";
import { resolveProjectId, seeCond, editCond } from "../meetings.js";
import { logAct } from "../_log.js";

export default wrap(async function handler(req, res) {
  const userId = requireAuth(req, res);
  if (!userId) return;

  const id = Number(req.query.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "invalid id" });

  if (req.method === "GET") {
    // 본인 것 · 전체 공개 · 프로젝트 소유자/멤버 열람 가능. can_edit = 본인 또는 프로젝트 소유자/멤버
    const [meeting] = await sql`
      SELECT m.*, (m.user_id = ${userId}) AS is_owner, ${editCond(userId)} AS can_edit,
             u.email AS owner_email, u2.email AS updated_by_email, p.name AS project_name
      FROM meetings m
      LEFT JOIN users u  ON u.id  = m.user_id
      LEFT JOIN users u2 ON u2.id = m.updated_by
      LEFT JOIN projects p ON p.id = m.project_id
      WHERE m.id = ${id} AND ${seeCond(userId)}`;
    if (!meeting) return res.status(404).json({ error: "not found" });
    meeting.raw_text = decryptText(meeting.raw_text); // 열람 권한 확인 후에만 복호화
    const items = await sql`
      SELECT * FROM action_items WHERE meeting_id = ${id} ORDER BY id`;
    return res.status(200).json({ ...meeting, action_items: items });
  }

  // 회의록 수정 — 소유자 또는 프로젝트 소유자/멤버. 액션 아이템은 전체 교체(삭제 후 재삽입, done 포함).
  if (req.method === "PUT") {
    const { title, text, summary, agenda, tags, visibility, action_items, project_id } = req.body ?? {};
    if (!title?.trim() || !text?.trim())
      return res.status(400).json({ error: "title과 text는 필수입니다." });
    if (title.length > 300) return res.status(400).json({ error: "제목이 너무 깁니다 (최대 300자)." });
    if (text.length > 1_000_000) return res.status(400).json({ error: "본문이 너무 깁니다 (최대 100만 자)." });
    if ((action_items?.length ?? 0) > 100) return res.status(400).json({ error: "액션 아이템이 너무 많습니다." });
    const vis = visibility === "workspace" ? "workspace" : "private";
    const projectId = await resolveProjectId(userId, project_id); // 권한 없는 프로젝트는 NULL

    const [meeting] = await sql`
      UPDATE meetings SET
        title = ${title}, raw_text = ${encryptText(text)}, summary = ${summary ?? []},
        agenda = ${sql.json(agenda ?? [])}, tags = ${tags ?? []}, visibility = ${vis},
        project_id = ${projectId},
        updated_at = now(), updated_by = ${userId}
      WHERE id = ${id} AND ${editCond(userId, "meetings")}
      RETURNING *`;
    if (!meeting) return res.status(404).json({ error: "not found" });
    meeting.raw_text = text; // 응답은 평문으로
    await logAct(userId, "meeting_update", `#${id} ${title}`);

    await sql`DELETE FROM action_items WHERE meeting_id = ${id}`;
    const items = [];
    for (const it of action_items ?? []) {
      const [row] = await sql`
        INSERT INTO action_items (meeting_id, task, assignee, due_date, done)
        VALUES (${id}, ${it.task}, ${it.assignee ?? null}, ${it.due_date ?? null}, ${!!it.done})
        RETURNING *`;
      items.push(row);
    }

    const [me] = await sql`SELECT email FROM users WHERE id = ${userId}`;
    const [owner] = await sql`SELECT email FROM users WHERE id = ${meeting.user_id}`;
    const [proj] = projectId
      ? await sql`SELECT name FROM projects WHERE id = ${projectId}`
      : [null];
    return res.status(200).json({
      ...meeting,
      action_items: items,
      is_owner: meeting.user_id === userId,
      can_edit: true,
      owner_email: owner?.email ?? null,
      updated_by_email: me?.email ?? null,
      project_name: proj?.name ?? null,
    });
  }

  // 회의록 삭제 — 소유자만. 액션 아이템은 FK CASCADE로 함께 삭제.
  if (req.method === "DELETE") {
    const [row] = await sql`
      DELETE FROM meetings WHERE id = ${id} AND user_id = ${userId} RETURNING id, title`;
    if (!row) return res.status(404).json({ error: "not found" });
    await logAct(userId, "meeting_delete", `#${id} ${row.title}`);
    return res.status(200).json({ ok: true });
  }

  if (req.method === "PATCH") {
    // 액션 아이템 완료 토글: { actionItemId, done } — 소유자·프로젝트 멤버 (공개 열람자는 불가)
    const { actionItemId, done } = req.body ?? {};
    const [row] = await sql`
      UPDATE action_items SET done = ${!!done}
      WHERE id = ${actionItemId} AND meeting_id = ${id}
        AND EXISTS (SELECT 1 FROM meetings m WHERE m.id = ${id} AND ${editCond(userId)})
      RETURNING *`;
    if (!row) return res.status(404).json({ error: "not found" });
    return res.status(200).json(row);
  }

  res.status(405).json({ error: "GET/PUT/PATCH/DELETE only" });
});
