import { sql } from "./_db.js";
import { wrap } from "./_wrap.js";
import { requireAuth, encryptSecret, decryptSecret } from "./_auth.js";
import { logAct } from "./_log.js";

// GET  /api/me → 내 계정 정보 + 사용할 Gemini 키(본인 키, 없고 허용됐으면 관리자 키)
//                관리자 키 사용 시 관리자가 지정한 모델(admin_model/admin_stt_model)도 포함
// PUT  /api/me { gemini_api_key? , shared_model?, shared_stt_model? }
//                키 저장(빈 문자열 = 삭제) / 공유 모델 지정(관리자 전용, 빈 문자열 = 지정 해제)
export default wrap(async function handler(req, res) {
  const userId = requireAuth(req, res);
  if (!userId) return;

  if (req.method === "PUT") {
    const b = req.body ?? {};
    if ("gemini_api_key" in b) {
      const key = String(b.gemini_api_key ?? "").trim();
      if (key.length > 300) return res.status(400).json({ error: "키가 너무 깁니다." });
      await sql`
        UPDATE users SET gemini_key_enc = ${key ? encryptSecret(key) : null}
        WHERE id = ${userId}`;
    }
    if ("gemini_api_key2" in b) {
      const key = String(b.gemini_api_key2 ?? "").trim();
      if (key.length > 300) return res.status(400).json({ error: "키가 너무 깁니다." });
      await sql`
        UPDATE users SET gemini_key2_enc = ${key ? encryptSecret(key) : null}
        WHERE id = ${userId}`;
    }
    if ("shared_model" in b || "shared_stt_model" in b) {
      const [u] = await sql`SELECT is_admin FROM users WHERE id = ${userId}`;
      if (!u?.is_admin) return res.status(403).json({ error: "공유 모델은 관리자만 지정할 수 있습니다." });
      const sm = String(b.shared_model ?? "").trim().slice(0, 100) || null;
      const ss = String(b.shared_stt_model ?? "").trim().slice(0, 100) || null;
      await sql`UPDATE users SET shared_model = ${sm}, shared_stt_model = ${ss} WHERE id = ${userId}`;
    }
    const changed = ["gemini_api_key", "gemini_api_key2", "shared_model"].filter((k) => k in b || (k === "shared_model" && "shared_stt_model" in b));
    if (changed.length) await logAct(userId, "key_save", changed.join(", ") + " 변경");
    return res.status(200).json({ ok: true });
  }

  if (req.method !== "GET") return res.status(405).json({ error: "GET/PUT only" });

  // 스키마 프로브 겸 마지막 접속 기록 — 새 컬럼/테이블이 빠진 DB면 여기서 오류가 나
  // 화면 배너의 [🔧 마이그레이션 실행] 버튼으로 안내된다. (스키마 변경 시 프로브도 갱신할 것)
  await sql`UPDATE users SET last_seen_at = now() WHERE id = ${userId}`;
  await sql`SELECT 1 FROM activity_log LIMIT 0`;

  const [me] = await sql`
    SELECT email, is_admin, can_use_admin_key, gemini_key_enc, gemini_key2_enc, shared_model, shared_stt_model
    FROM users WHERE id = ${userId}`;
  if (!me) return res.status(401).json({ error: "로그인이 필요합니다." });

  const ownKey = me.gemini_key_enc ? decryptSecret(me.gemini_key_enc) : null;

  // 본인 키가 없고 관리자 키 사용이 허용된 회원이면 관리자의 키(+지정 모델)를 내려준다
  let adminKey = null;
  let adminModels = {};
  if (!ownKey && me.can_use_admin_key) {
    const [admin] = await sql`
      SELECT gemini_key_enc, shared_model, shared_stt_model FROM users
      WHERE is_admin = true AND gemini_key_enc IS NOT NULL
      ORDER BY id LIMIT 1`;
    if (admin) {
      adminKey = decryptSecret(admin.gemini_key_enc);
      adminModels = { admin_model: admin.shared_model, admin_stt_model: admin.shared_stt_model };
    }
  }

  res.status(200).json({
    email: me.email,
    is_admin: me.is_admin,
    can_use_admin_key: me.can_use_admin_key,
    has_own_key: !!ownKey,
    using_admin_key: !ownKey && !!adminKey,
    gemini_key: ownKey ?? adminKey ?? "",
    // 유료(예비) 키 — 본인 키가 429(무료 한도 소진)를 반환하면 브라우저가 자동 전환
    gemini_key2: (me.gemini_key2_enc ? decryptSecret(me.gemini_key2_enc) : null) ?? "",
    // 관리자 본인: Settings 프리필용 / 관리자 키 사용자: 강제할 모델
    ...(me.is_admin && { shared_model: me.shared_model, shared_stt_model: me.shared_stt_model }),
    ...(!ownKey && adminKey ? adminModels : {}),
  });
});
