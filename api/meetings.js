import { sql } from "./_db.js";
import { wrap } from "./_wrap.js";
import { requireAuth } from "./_auth.js";

export default wrap(async function handler(req, res) {
  if (!requireAuth(req, res)) return;

  // 미리보기 확인 후 저장: summarize 결과 + 원문을 받아 DB에 기록
  if (req.method === "POST") {
    const { title, text, summary, agenda, action_items, tags } = req.body ?? {};
    if (!title?.trim() || !text?.trim())
      return res.status(400).json({ error: "title과 text는 필수입니다." });
    if (title.length > 300) return res.status(400).json({ error: "제목이 너무 깁니다 (최대 300자)." });
    if (text.length > 1_000_000) return res.status(400).json({ error: "본문이 너무 깁니다 (최대 100만 자)." });
    if ((action_items?.length ?? 0) > 100) return res.status(400).json({ error: "액션 아이템이 너무 많습니다." });

    const [meeting] = await sql`
      INSERT INTO meetings (title, raw_text, summary, agenda, tags)
      VALUES (${title}, ${text}, ${summary ?? []}, ${sql.json(agenda ?? [])}, ${tags ?? []})
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
  // ponytail: ILIKE 검색으로 충분. 태그 검색 포함, 데이터 커지면 FTS로 교체.
  const rows = q
    ? await sql`
        SELECT id, title, summary, tags, created_at FROM meetings
        WHERE title ILIKE ${"%" + q + "%"}
           OR raw_text ILIKE ${"%" + q + "%"}
           OR ${q} = ANY(tags)
        ORDER BY created_at DESC`
    : await sql`
        SELECT id, title, summary, tags, created_at FROM meetings
        ORDER BY created_at DESC`;

  res.status(200).json(rows);
});
