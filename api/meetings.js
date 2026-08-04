import { sql } from "./_db.js";
import { wrap } from "./_wrap.js";
import { requireAuth, encryptText, decryptSecret } from "./_auth.js";
import { logAct, tryRecord } from "./_log.js";
import { pushToNotion, extractNotionId } from "./_notion.js";
import { pushTasksToDooray, pushWikiToDooray } from "./_dooray.js";

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);

// 사용자가 쓸 수 있는 프로젝트인지 (본인 소유·공유·멤버). 아니면 null 반환.
export async function resolveProjectId(userId, raw) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) return null;
  const [p] = await sql`
    SELECT id FROM projects
    WHERE id = ${id} AND (owner_id = ${userId} OR is_shared = true
      OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = projects.id AND pm.user_id = ${userId}))`;
  return p?.id ?? null;
}

// 프로젝트를 통한 접근: 프로젝트 소유자·멤버는 그 프로젝트의 모든 회의록에 접근 (t = 테이블 별칭)
const projCond = (userId, t) => sql`(${sql(t)}.project_id IS NOT NULL AND (
  EXISTS (SELECT 1 FROM projects _pp WHERE _pp.id = ${sql(t)}.project_id AND _pp.owner_id = ${userId})
  OR EXISTS (SELECT 1 FROM project_members _pm
              WHERE _pm.project_id = ${sql(t)}.project_id AND _pm.user_id = ${userId})))`;

// 열람 가능: 본인 것 · 전체 공개 · 프로젝트 소유자/멤버
export const seeCond = (userId, t = "m") =>
  sql`(${sql(t)}.user_id = ${userId} OR ${sql(t)}.visibility = 'workspace' OR ${projCond(userId, t)})`;

// 수정 가능: 본인 것 · 프로젝트 소유자/멤버
export const editCond = (userId, t = "m") =>
  sql`(${sql(t)}.user_id = ${userId} OR ${projCond(userId, t)})`;

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
    const tz = String(req.body?.tz ?? "").slice(0, 50) || null; // 작성자 시간대(IANA)

    // 원문은 암호화 저장 — DB가 유출되거나 콘솔에서 직접 조회해도 내용을 볼 수 없음
    const [meeting] = await sql`
      INSERT INTO meetings (user_id, project_id, title, raw_text, summary, agenda, tags, visibility, tz)
      VALUES (${userId}, ${projectId}, ${title}, ${encryptText(text)}, ${summary ?? []}, ${sql.json(agenda ?? [])}, ${tags ?? []}, ${vis}, ${tz})
      RETURNING *`;
    meeting.raw_text = text; // 응답은 평문으로
    await logAct(userId, "meeting_create", `#${meeting.id} ${title}`);

    // 연동: 설정돼 있고, 이 회의록에서 켜져 있으면(기본 켜짐) Notion 페이지 생성 + Dooray 업무 등록.
    // ⚠️ 어떤 오류가 나도(설정 컬럼 미존재 = 마이그레이션 미실행 포함) 회의록 저장은
    // 이미 완료된 상태를 깨지 않는다 — 결과만 응답에 담아 화면에 알린다.
    const integrations = {};
    try {
      const wantNotion = req.body?.notion !== false; // 회의록별 선택 (미전달 시 켜짐)
      const wantDooray = req.body?.dooray !== false;
      const [cfg] = await sql`
        SELECT notion_token_enc, notion_target_id, notion_target_type, dooray_token_enc, dooray_project_id
        FROM users WHERE id = ${userId}`;
      let projectName = null;
      let projectDoorayId = null;
      let projectNotion = null; // { id, type } — 프로젝트별 Notion 저장 위치
      if (projectId) {
        const [pj] = await sql`
          SELECT name, dooray_project_id, notion_target_id, notion_target_type FROM projects WHERE id = ${projectId}`;
        projectName = pj?.name ?? null;
        projectDoorayId = pj?.dooray_project_id ?? null;
        if (pj?.notion_target_id) projectNotion = { id: pj.notion_target_id, type: pj.notion_target_type ?? "database" };
      }
      const meetingData = {
        title, text,
        summary: summary ?? [], agenda: agenda ?? [], action_items: action_items ?? [], tags: tags ?? [],
        project: projectName, meetingId: meeting.id, createdAt: meeting.created_at,
      };
      // Notion 대상: 프로젝트별 매핑 우선, 없으면 설정의 기본 테이블 (토큰은 항상 사용자 공용 토큰)
      const notionTarget = projectNotion ?? (cfg?.notion_target_id ? { id: cfg.notion_target_id, type: cfg.notion_target_type ?? "database" } : null);
      if (wantNotion && cfg?.notion_token_enc && notionTarget) {
        try {
          // 새 회의록이지만, 같은 회의록 ID의 행이 이미 있으면 pushToNotion이 그 행을 업데이트한다
          const { url, pageId } = await pushToNotion(
            { token: decryptSecret(cfg.notion_token_enc), targetId: notionTarget.id, targetType: notionTarget.type },
            meetingData,
          );
          integrations.notion = { ok: true, url };
          // 기록 실패(마이그레이션 미실행 등)가 성공한 전송을 실패로 만들지 않게
          await tryRecord(
            () => sql`
              UPDATE meetings SET notion_synced_at = now(), notion_page_id = ${pageId},
                     notion_target_sent = ${extractNotionId(notionTarget.id)}
              WHERE id = ${meeting.id}`,
            userId, "Notion 전송 이력",
          );
          await logAct(userId, "notion_sync", `#${meeting.id} ${title}${url ? ` → ${url}` : ""}`);
        } catch (e) {
          integrations.notion = { ok: false, error: e.message };
          await logAct(userId, "notion_error", `#${meeting.id} ${e.message}`);
        }
      }
      // Dooray 대상: 회의록 프로젝트에 매핑된 Dooray 프로젝트 우선, 없으면 설정의 기본값
      const doorayPid = projectDoorayId || cfg?.dooray_project_id;
      if (wantDooray && cfg?.dooray_token_enc && doorayPid) {
        try {
          const dcfg = { token: decryptSecret(cfg.dooray_token_enc), projectId: doorayPid };
          await pushWikiToDooray(dcfg, meetingData); // 회의록 본문 → 프로젝트 위키
          let r = { created: 0, failed: 0 };
          if (meetingData.action_items.length) r = await pushTasksToDooray(dcfg, meetingData); // 액션 아이템 → 업무
          integrations.dooray = { ok: true, wiki: true, ...r };
          await tryRecord(
            () => sql`
              UPDATE meetings SET dooray_synced_at = now(), dooray_target_sent = ${String(doorayPid)}
              WHERE id = ${meeting.id}`,
            userId, "Dooray 전송 이력",
          );
          await logAct(userId, "dooray_sync", `#${meeting.id} 위키 저장 + 업무 ${r.created}건 (프로젝트 ${doorayPid})`);
        } catch (e) {
          integrations.dooray = { ok: false, error: e.message };
          await logAct(userId, "dooray_error", `#${meeting.id} ${e.message}`);
        }
      }
    } catch (e) {
      // 연동 설정 조회 자체가 실패(예: 마이그레이션 미실행) — 저장은 성공이므로 안내만
      integrations.notion = { ok: false, error: "연동 설정을 읽지 못했습니다: " + e.message };
    }
    meeting.integrations = integrations;

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
    SELECT m.id, m.title, m.summary, m.tags, m.created_at, m.visibility, m.tz,
           m.notion_synced_at, m.dooray_synced_at,
           m.project_id, p.name AS project_name,
           (m.user_id = ${userId}) AS is_owner, u.email AS owner_email
    FROM meetings m
    LEFT JOIN users u ON u.id = m.user_id
    LEFT JOIN projects p ON p.id = m.project_id
    WHERE ${seeCond(userId)}
    ${q ? sql`AND (m.title ILIKE ${"%" + q + "%"} OR array_to_string(m.summary, ' ') ILIKE ${"%" + q + "%"} OR ${q} = ANY(m.tags))` : sql``}
    ${isDate(from) ? sql`AND m.created_at >= ${from}::date` : sql``}
    ${isDate(to) ? sql`AND m.created_at < ${to}::date + 1` : sql``}
    ${project === "none" ? sql`AND m.project_id IS NULL` : /^\d+$/.test(project) ? sql`AND m.project_id = ${Number(project)}` : sql``}
    ORDER BY m.created_at DESC
    ${/^\d+$/.test(req.query.limit ?? "") ? sql`LIMIT ${Math.min(1000, Number(req.query.limit))}` : sql``}`;

  res.status(200).json(rows);
});
