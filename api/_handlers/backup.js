import { sql } from "../_db.js";
import { wrap } from "../_wrap.js";
import { requireAuth, encryptText, decryptText } from "../_auth.js";
import { seeCond } from "../meetings.js";
import { logAct } from "../_log.js";

// GET  /api/backup            → 내가 보는 회의록 전체를 CSV로 (본인 작성 + 공유받은 것)
// POST /api/backup { rows }   → CSV에서 읽은 행들을 내 계정으로 복구 (있으면 갱신, 없으면 추가)
//
// CSV 열: id, created_at, tz, project, visibility, title, summary, agenda, action_items, tags, raw_text
// 구조가 있는 열(summary/agenda/action_items/tags)은 JSON 문자열로 저장 — 그대로 되돌릴 수 있게.

const COLS = [
  "id", "created_at", "owner", "tz", "project", "visibility",
  "title", "summary", "agenda", "action_items", "tags", "raw_text",
];

// RFC4180: 큰따옴표·쉼표·줄바꿈이 있으면 감싸고 따옴표는 두 번
const cell = (v) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export default wrap(async function handler(req, res) {
  const userId = requireAuth(req, res);
  if (!userId) return;

  if (req.method === "GET") {
    const rows = await sql`
      SELECT m.id, m.created_at, m.tz, m.visibility, m.title, m.raw_text, m.summary, m.agenda, m.tags,
             p.name AS project, u.email AS owner,
             COALESCE((SELECT json_agg(json_build_object(
                         'task', a.task, 'assignee', a.assignee, 'due_date', a.due_date, 'done', a.done)
                       ORDER BY a.id)
                       FROM action_items a WHERE a.meeting_id = m.id), '[]'::json) AS action_items
      FROM meetings m
      LEFT JOIN projects p ON p.id = m.project_id
      LEFT JOIN users u ON u.id = m.user_id
      WHERE ${seeCond(userId)}
      ORDER BY m.id`;

    const body = rows.map((r) =>
      [
        r.id,
        r.created_at?.toISOString?.() ?? r.created_at,
        r.owner ?? "",
        r.tz ?? "",
        r.project ?? "",
        r.visibility,
        r.title,
        JSON.stringify(r.summary ?? []),
        JSON.stringify(r.agenda ?? []),
        JSON.stringify(r.action_items ?? []),
        JSON.stringify(r.tags ?? []),
        decryptText(r.raw_text), // 암호화 저장된 원문 → 백업에는 평문으로
      ].map(cell).join(","),
    );
    await logAct(userId, "backup_export", `${rows.length}건 CSV 내려받기`);

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="meeting-minutes-backup.csv"');
    // BOM — Excel이 UTF-8 한글을 깨뜨리지 않게
    res.statusCode = 200;
    return res.end("﻿" + [COLS.join(","), ...body].join("\r\n"));
  }

  if (req.method !== "POST") return res.status(405).json({ error: "GET/POST only" });

  const rows = req.body?.rows;
  if (!Array.isArray(rows)) return res.status(400).json({ error: "rows 배열이 필요합니다." });
  if (rows.length > 50) return res.status(400).json({ error: "한 번에 최대 50건씩 보내주세요." });

  // 문자열/배열 어느 쪽으로 와도 받아준다 (엑셀에서 손댄 파일도 복구되게)
  const asArray = (v, sep = /\r?\n/) => {
    if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
    const s = String(v ?? "").trim();
    if (!s) return [];
    if (s.startsWith("[")) { try { return JSON.parse(s); } catch { /* 아래 폴백 */ } }
    return s.split(sep).map((x) => x.trim()).filter(Boolean);
  };
  const asObjects = (v) => {
    if (Array.isArray(v)) return v;
    const s = String(v ?? "").trim();
    if (!s.startsWith("[")) return [];
    try {
      const a = JSON.parse(s);
      return Array.isArray(a) ? a : [];
    } catch {
      return [];
    }
  };

  // 프로젝트는 이름으로 맞춘다 — 없으면 내 프로젝트로 새로 만든다 (id는 DB마다 다르므로)
  const projectCache = new Map();
  const findProject = async (name) => {
    const n = String(name ?? "").trim();
    if (!n) return null;
    if (projectCache.has(n)) return projectCache.get(n);
    const [p] = await sql`
      SELECT id FROM projects
      WHERE name = ${n} AND (owner_id = ${userId} OR is_shared = true
        OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = projects.id AND pm.user_id = ${userId}))
      ORDER BY id LIMIT 1`;
    const id = p?.id ?? (await sql`
      INSERT INTO projects (name, owner_id) VALUES (${n}, ${userId}) RETURNING id`)[0].id;
    projectCache.set(n, id);
    return id;
  };

  const [me] = await sql`SELECT email FROM users WHERE id = ${userId}`;
  let inserted = 0, updated = 0, skipped = 0;
  const errors = [];

  for (const [i, r] of rows.entries()) {
    const title = String(r.title ?? "").trim();
    const text = String(r.raw_text ?? "");
    if (!title || !text.trim()) {
      skipped++;
      errors.push(`${i + 1}행: 제목 또는 원문이 비어 건너뜀`);
      continue;
    }
    try {
      const summary = asArray(r.summary);
      const agenda = asObjects(r.agenda);
      const items = asObjects(r.action_items).slice(0, 100);
      const tags = asArray(r.tags, /[,\n]/);
      const vis = r.visibility === "workspace" ? "workspace" : "private";
      const projectId = await findProject(r.project);
      const tz = String(r.tz ?? "").slice(0, 50) || null;
      const created = r.created_at && !Number.isNaN(Date.parse(r.created_at)) ? new Date(r.created_at) : null;

      // 같은 id의 회의록이 내 것이면 갱신, 아니면 새로 추가 (다른 사람 회의록은 절대 건드리지 않음).
      // 삭제 후 복구하면 id가 새로 매겨지므로, id가 안 맞으면 제목+생성시각으로 한 번 더 찾는다
      // — 같은 파일로 두 번 복구해도 사본이 생기지 않게.
      const id = Number(r.id);
      let [mine] = Number.isInteger(id) && id > 0
        ? await sql`SELECT id FROM meetings WHERE id = ${id} AND user_id = ${userId}`
        : [];
      if (!mine && created)
        [mine] = await sql`
          SELECT id FROM meetings
          WHERE user_id = ${userId} AND title = ${title}
            AND date_trunc('milliseconds', created_at) = ${created} LIMIT 1`;

      // 공유받은(남이 쓴) 회의록: 원본이 아직 보이면 건너뛴다 — 내 계정으로 복제하지 않기 위해.
      // 원본이 사라졌을 때만 내 사본으로 되살린다.
      const owner = String(r.owner ?? "").trim().toLowerCase();
      if (!mine && owner && owner !== me.email && created) {
        const [alive] = await sql`
          SELECT m.id FROM meetings m
          WHERE m.title = ${title} AND date_trunc('milliseconds', m.created_at) = ${created}
            AND ${seeCond(userId)} LIMIT 1`;
        if (alive) {
          skipped++;
          errors.push(`${i + 1}행: 공유받은 회의록(${owner})이 그대로 있어 건너뜀`);
          continue;
        }
      }

      let meetingId;
      if (mine) {
        await sql`
          UPDATE meetings SET
            title = ${title}, raw_text = ${encryptText(text)}, summary = ${summary},
            agenda = ${sql.json(agenda)}, tags = ${tags}, visibility = ${vis},
            project_id = ${projectId}, tz = ${tz}, updated_at = now(), updated_by = ${userId}
          WHERE id = ${mine.id}`;
        await sql`DELETE FROM action_items WHERE meeting_id = ${mine.id}`;
        meetingId = mine.id;
        updated++;
      } else {
        const [m] = await sql`
          INSERT INTO meetings (user_id, project_id, title, raw_text, summary, agenda, tags, visibility, tz, created_at)
          VALUES (${userId}, ${projectId}, ${title}, ${encryptText(text)}, ${summary},
                  ${sql.json(agenda)}, ${tags}, ${vis}, ${tz}, ${created ?? sql`now()`})
          RETURNING id`;
        meetingId = m.id;
        inserted++;
      }

      for (const a of items) {
        const task = String(a?.task ?? "").trim();
        if (!task) continue;
        await sql`
          INSERT INTO action_items (meeting_id, task, assignee, due_date, done)
          VALUES (${meetingId}, ${task}, ${a.assignee ?? null}, ${a.due_date ?? null}, ${a.done === true || a.done === "true"})`;
      }
    } catch (e) {
      skipped++;
      errors.push(`${i + 1}행(${title.slice(0, 20)}): ${e.message}`);
    }
  }

  await logAct(userId, "backup_restore", `추가 ${inserted} · 갱신 ${updated} · 건너뜀 ${skipped}`);
  return res.status(200).json({ inserted, updated, skipped, errors: errors.slice(0, 5) });
});
