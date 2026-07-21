import { sql } from "./_db.js";
import { wrap } from "./_wrap.js";
import { requireAuth, decryptSecret } from "./_auth.js";
import { testNotion } from "./_notion.js";
import { testDooray } from "./_dooray.js";

// POST /api/integrations { action: "notion_test" | "dooray_test" }
// 저장된 연동 설정으로 실제 접근이 되는지 확인 (설정 화면의 [연결 테스트] 버튼)
export default wrap(async function handler(req, res) {
  const userId = requireAuth(req, res);
  if (!userId) return;
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const [u] = await sql`
    SELECT notion_token_enc, notion_target_id, notion_target_type, dooray_token_enc, dooray_project_id
    FROM users WHERE id = ${userId}`;

  const action = req.body?.action;
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
