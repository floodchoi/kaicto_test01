import { sql } from "./_db.js";
import { wrap } from "./_wrap.js";
import { requireAuth } from "./_auth.js";

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);

// 사용자가 쓸 수 있는 프로젝트인지 (본인 소유 또는 공유). 아니면 null 반환.
export async function resolveProjectId(userId, raw) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) return null;
  const [p] = await sql`
    SELECT id FROM projects WHERE id = ${id} AND (owner_id = ${userId} OR is_shared = true)`;
  return p?.id ?? null;
}

export default wrap(async function handler(req, res) {
  const userId = requireAuth(req, res);
  if (!userId) return;

  // 미리보기 확인 후 저장: summarize 결과 + 원문을 받아 DB에 기록
  if (req.method === "POST") {
    const { title, text, summary, agenda, action_items, tags, visibility, project_id } = req.body ?? {};
    if (!title?.trim() || !text?.trim())
      return res.status(400).json({ error: "title과 text는 필수입니다." });
    if (title.length > 300) return res.status(400).json({ error: "제목이 너무 깁니다 (최대 300자)." });
    if (text.length > 1_000_000) return res.status(400).json({ error: "본문이 너무 깁니다 (최대 100만 자)." });
    if ((action_items?.length ?? 0) > 100) return res.status(400).json({ error: "액션 아이템이 너무 많습니다." });
    const vis = visibility === "workspace" ? "workspace" : "private";
    const projectId = await resolveProjectId(userId, project_id); // 권한 없는 프로젝트는 무시(NULL)

    const [meeting] = await sql`
      INSERT INTO meetings (user_id, project_id, title, raw_text, summary, agenda, tags, visibility)
      VALUES (${userId}, ${projectId}, ${title}, ${text}, ${summary ?? []}, ${sql.json(agenda ?? [])}, ${tags ?? []}, ${vis})
      RETURNING *`;

    const items = [];
    for (const it of action_items ?? []) {
      const [row] = await sql`
        INSERT INTO action_items (meeting_id, task, assignee, due_date)
        VALUES (${meeting.id}, ${it.task}, ${it.assignee ?? null}, ${it.due_date ?? null})
        RETURNING *`;
      items.push(row);
    }
    return res.status(200).json({ ...meeting, action_items: items });
  }

  if (req.method !== "GET") return res.status(405).json({ error: "GET/POST only" });

  const q = (req.query.q ?? "").trim();
  const from = (req.query.from ?? "").trim();
  const to = (req.query.to ?? "").trim();
  const project = (req.query.project ?? "").trim(); // ""=전체, "none"=미분류, 숫자=해당 프로젝트

  // 본인 것 + 전체 공개(workspace)만. ponytail: ILIKE 검색으로 충분, 커지면 FTS.
  const rows = await sql`
    SELECT m.id, m.title, m.summary, m.tags, m.created_at, m.visibility,
           m.project_id, p.name AS project_name,
           (m.user_id = ${userId}) AS is_owner, u.email AS owner_email
    FROM meetings m
    LEFT JOIN users u ON u.id = m.user_id
    LEFT JOIN projects p ON p.id = m.project_id
    WHERE (m.user_id = ${userId} OR m.visibility = 'workspace')
    ${q ? sql`AND (m.title ILIKE ${"%" + q + "%"} OR m.raw_text ILIKE ${"%" + q + "%"} OR ${q} = ANY(m.tags))` : sql``}
    ${isDate(from) ? sql`AND m.created_at >= ${from}::date` : sql``}
    ${isDate(to) ? sql`AND m.created_at < ${to}::date + 1` : sql``}
    ${project === "none" ? sql`AND m.project_id IS NULL` : /^\d+$/.test(project) ? sql`AND m.project_id = ${Number(project)}` : sql``}
    ORDER BY m.created_at DESC`;

  res.status(200).json(rows);
});
