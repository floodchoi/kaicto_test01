import { sql } from "../_db.js";
import { wrap } from "../_wrap.js";
import { requireAuth, decryptSecret, decryptText } from "../_auth.js";
import { testNotion, pushToNotion } from "../_notion.js";
import { testDooray, pushTasksToDooray } from "../_dooray.js";
import { editCond } from "../meetings.js";
import { logAct } from "../_log.js";

// POST /api/integrations
//  { action: "notion_test" | "dooray_test" }   → 연결 확인 (설정 화면의 [연결 테스트])
//  { action: "sync", meetingId }               → 저장된 회의록을 지금 다시 전송
//    (저장 시 실패했거나, 연동 설정 전에 만든 회의록을 나중에 보낼 때)
export default wrap(async function handler(req, res) {
  const userId = requireAuth(req, res);
  if (!userId) return;
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  let u;
  try {
    [u] = await sql`
      SELECT notion_token_enc, notion_target_id, notion_target_type, dooray_token_enc, dooray_project_id
      FROM users WHERE id = ${userId}`;
  } catch (e) {
    // 연동 컬럼이 없는 DB = 마이그레이션 미실행 — 원인을 짚어서 안내
    if (/does not exist/i.test(e.message))
      return res.status(400).json({
        error: "DB 마이그레이션이 필요합니다 — 화면 상단 배너의 [🔧 마이그레이션 실행 (관리자)] 버튼을 누른 뒤 다시 시도해주세요.",
      });
    throw e;
  }

  const action = req.body?.action;
  const hasNotion = !!(u?.notion_token_enc && u?.notion_target_id);
  const hasDooray = !!(u?.dooray_token_enc && u?.dooray_project_id);

  // 회의록 1건 로드(권한 검사 포함) + 전송용 데이터 구성. 없으면 null.
  const loadMeeting = async (meetingId) => {
    const [m] = await sql`
      SELECT m.*, p.name AS project_name FROM meetings m
      LEFT JOIN projects p ON p.id = m.project_id
      WHERE m.id = ${meetingId} AND ${editCond(userId)}`;
    if (!m) return null;
    const items = await sql`
      SELECT task, assignee, due_date, done FROM action_items WHERE meeting_id = ${meetingId} ORDER BY id`;
    return {
      m,
      data: {
        title: m.title,
        text: decryptText(m.raw_text),
        summary: m.summary ?? [],
        agenda: m.agenda ?? [],
        action_items: items,
        tags: m.tags ?? [],
        project: m.project_name ?? null,
        meetingId: m.id,
      },
    };
  };

  // 한 회의록을 Notion/Dooray로 전송 (성공 시 synced_at 기록). skipSynced=true면 이미 전송분 건너뜀.
  const sendOne = async ({ m, data }, skipSynced, label = "") => {
    const out = {};
    if (hasNotion) {
      if (skipSynced && m.notion_synced_at) out.notion = { skipped: true };
      else {
        try {
          const url = await pushToNotion(
            { token: decryptSecret(u.notion_token_enc), targetId: u.notion_target_id, targetType: u.notion_target_type ?? "database" },
            data,
          );
          out.notion = { ok: true, url };
          await sql`UPDATE meetings SET notion_synced_at = now() WHERE id = ${m.id}`;
          await logAct(userId, "notion_sync", `#${m.id} ${m.title}${label}${url ? ` → ${url}` : ""}`);
        } catch (e) {
          out.notion = { ok: false, error: e.message };
          await logAct(userId, "notion_error", `#${m.id}${label} ${e.message}`);
        }
      }
    }
    if (hasDooray && data.action_items.length) {
      if (skipSynced && m.dooray_synced_at) out.dooray = { skipped: true };
      else {
        try {
          const r = await pushTasksToDooray(
            { token: decryptSecret(u.dooray_token_enc), projectId: u.dooray_project_id },
            data,
          );
          out.dooray = { ok: true, ...r };
          await sql`UPDATE meetings SET dooray_synced_at = now() WHERE id = ${m.id}`;
          await logAct(userId, "dooray_sync", `#${m.id} 업무 ${r.created}건 등록${label}`);
        } catch (e) {
          out.dooray = { ok: false, error: e.message };
          await logAct(userId, "dooray_error", `#${m.id}${label} ${e.message}`);
        }
      }
    }
    return out;
  };

  if (action === "sync") {
    if (!hasNotion && !hasDooray)
      return res.status(400).json({ error: "먼저 ⚙️ 설정에서 Notion 또는 Dooray 연동을 등록해주세요." });
    const loaded = await loadMeeting(Number(req.body?.meetingId));
    if (!loaded) return res.status(404).json({ error: "회의록을 찾을 수 없습니다." });
    // 상세 화면의 수동 재전송 — 이미 전송됐어도 강제 재전송 (중복 경고는 UI에서)
    return res.status(200).json(await sendOne(loaded, false, " (재전송)"));
  }

  // 목록에서 여러 회의록 일괄 전송 — 이미 전송된 회의록은 자동 건너뜀
  if (action === "bulk_sync") {
    if (!hasNotion && !hasDooray)
      return res.status(400).json({ error: "먼저 ⚙️ 설정에서 Notion 또는 Dooray 연동을 등록해주세요." });
    const ids = [...new Set((req.body?.meetingIds ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 30);
    if (!ids.length) return res.status(400).json({ error: "전송할 회의록을 선택해주세요." });

    const summary = { sent: 0, skipped: 0, failed: 0, missing: 0, errors: [] };
    for (const id of ids) {
      const loaded = await loadMeeting(id);
      if (!loaded) {
        summary.missing++;
        continue;
      }
      const out = await sendOne(loaded, true, " (일괄)");
      const parts = [out.notion, out.dooray].filter(Boolean);
      if (parts.some((p) => p.ok)) summary.sent++;
      else if (parts.length && parts.every((p) => p.skipped)) summary.skipped++;
      else if (parts.some((p) => p.error)) {
        summary.failed++;
        if (summary.errors.length < 3)
          summary.errors.push(`#${id}: ${parts.find((p) => p.error)?.error}`);
      } else summary.skipped++; // 보낼 것이 없던 경우(예: Dooray만 설정 + 액션아이템 없음)
    }
    await logAct(userId, "notion_sync", `일괄 전송: 성공 ${summary.sent} · 건너뜀 ${summary.skipped} · 실패 ${summary.failed}`);
    return res.status(200).json(summary);
  }
  if (action === "notion_test") {
    if (!u?.notion_token_enc || !u?.notion_target_id)
      return res.status(400).json({ error: "먼저 Notion 토큰과 대상(페이지/DB)을 저장해주세요." });
    try {
      const title = await testNotion({
        token: decryptSecret(u.notion_token_enc),
        targetId: u.notion_target_id,
        targetType: u.notion_target_type ?? "database",
      });
      return res.status(200).json({ ok: true, title });
    } catch (e) {
      // 접근 실패는 서버 장애(500)가 아니라 설정 문제 — 원인을 그대로 안내
      return res.status(400).json({ error: e.message });
    }
  }
  if (action === "dooray_test") {
    if (!u?.dooray_token_enc || !u?.dooray_project_id)
      return res.status(400).json({ error: "먼저 Dooray 토큰과 프로젝트 ID를 저장해주세요." });
    try {
      const name = await testDooray({
        token: decryptSecret(u.dooray_token_enc),
        projectId: u.dooray_project_id,
      });
      return res.status(200).json({ ok: true, title: String(name) });
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
  }
  res.status(400).json({ error: "action은 notion_test 또는 dooray_test여야 합니다." });
});
