import { sql } from "./_db.js";
import { wrap } from "./_wrap.js";
import { requireAuth, decryptSecret, decryptText } from "./_auth.js";
import { testNotion, pushToNotion } from "./_notion.js";
import { testDooray, pushTasksToDooray } from "./_dooray.js";
import { editCond } from "./meetings.js";
import { logAct } from "./_log.js";

// POST /api/integrations
//  { action: "notion_test" | "dooray_test" }   → 연결 확인 (설정 화면의 [연결 테스트])
//  { action: "sync", meetingId }               → 저장된 회의록을 지금 다시 전송
//    (저장 시 실패했거나, 연동 설정 전에 만든 회의록을 나중에 보낼 때)
export default wrap(async function handler(req, res) {
  const userId = requireAuth(req, res);
  if (!userId) return;
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const [u] = await sql`
    SELECT notion_token_enc, notion_target_id, notion_target_type, dooray_token_enc, dooray_project_id
    FROM users WHERE id = ${userId}`;

  const action = req.body?.action;

  if (action === "sync") {
    const meetingId = Number(req.body?.meetingId);
    const hasNotion = !!(u?.notion_token_enc && u?.notion_target_id);
    const hasDooray = !!(u?.dooray_token_enc && u?.dooray_project_id);
    if (!hasNotion && !hasDooray)
      return res.status(400).json({ error: "먼저 ⚙️ 설정에서 Notion 또는 Dooray 연동을 등록해주세요." });

    const [m] = await sql`
      SELECT m.* FROM meetings m WHERE m.id = ${meetingId} AND ${editCond(userId)}`;
    if (!m) return res.status(404).json({ error: "회의록을 찾을 수 없습니다." });
    const items = await sql`
      SELECT task, assignee, due_date, done FROM action_items WHERE meeting_id = ${meetingId} ORDER BY id`;
    const data = {
      title: m.title,
      text: decryptText(m.raw_text),
      summary: m.summary ?? [],
      agenda: m.agenda ?? [],
      action_items: items,
      tags: m.tags ?? [],
    };

    const out = {};
    if (hasNotion) {
      try {
        const url = await pushToNotion(
          { token: decryptSecret(u.notion_token_enc), targetId: u.notion_target_id, targetType: u.notion_target_type ?? "database" },
          data,
        );
        out.notion = { ok: true, url };
        await logAct(userId, "notion_sync", `#${meetingId} ${m.title} (재전송)${url ? ` → ${url}` : ""}`);
      } catch (e) {
        out.notion = { ok: false, error: e.message };
        await logAct(userId, "notion_error", `#${meetingId} (재전송) ${e.message}`);
      }
    }
    if (hasDooray && items.length) {
      try {
        const r = await pushTasksToDooray(
          { token: decryptSecret(u.dooray_token_enc), projectId: u.dooray_project_id },
          data,
        );
        out.dooray = { ok: true, ...r };
        await logAct(userId, "dooray_sync", `#${meetingId} 업무 ${r.created}건 등록 (재전송)`);
      } catch (e) {
        out.dooray = { ok: false, error: e.message };
        await logAct(userId, "dooray_error", `#${meetingId} (재전송) ${e.message}`);
      }
    }
    return res.status(200).json(out);
  }
  if (action === "notion_test") {
    if (!u?.notion_token_enc || !u?.notion_target_id)
      return res.status(400).json({ error: "먼저 Notion 토큰과 대상(페이지/DB)을 저장해주세요." });
    const title = await testNotion({
      token: decryptSecret(u.notion_token_enc),
      targetId: u.notion_target_id,
      targetType: u.notion_target_type ?? "database",
    });
    return res.status(200).json({ ok: true, title });
  }
  if (action === "dooray_test") {
    if (!u?.dooray_token_enc || !u?.dooray_project_id)
      return res.status(400).json({ error: "먼저 Dooray 토큰과 프로젝트 ID를 저장해주세요." });
    const name = await testDooray({
      token: decryptSecret(u.dooray_token_enc),
      projectId: u.dooray_project_id,
    });
    return res.status(200).json({ ok: true, title: String(name) });
  }
  res.status(400).json({ error: "action은 notion_test 또는 dooray_test여야 합니다." });
});
