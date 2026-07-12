import { sql } from "./_db.js";
import { wrap } from "./_wrap.js";
import { requireAuth, encryptSecret, decryptSecret } from "./_auth.js";

// GET  /api/me → 내 계정 정보 + 사용할 Gemini 키(본인 키, 없고 허용됐으면 관리자 키)
// PUT  /api/me { gemini_api_key } → 내 Gemini 키 저장 (빈 문자열 = 삭제)
export default wrap(async function handler(req, res) {
  const userId = requireAuth(req, res);
  if (!userId) return;

  if (req.method === "PUT") {
    const key = String(req.body?.gemini_api_key ?? "").trim();
    if (key.length > 300) return res.status(400).json({ error: "키가 너무 깁니다." });
    await sql`
      UPDATE users SET gemini_key_enc = ${key ? encryptSecret(key) : null}
      WHERE id = ${userId}`;
    return res.status(200).json({ ok: true });
  }

  if (req.method !== "GET") return res.status(405).json({ error: "GET/PUT only" });

  const [me] = await sql`
    SELECT email, is_admin, can_use_admin_key, gemini_key_enc
    FROM users WHERE id = ${userId}`;
  if (!me) return res.status(401).json({ error: "로그인이 필요합니다." });

  const ownKey = me.gemini_key_enc ? decryptSecret(me.gemini_key_enc) : null;

  // 본인 키가 없고 관리자 키 사용이 허용된 회원이면 관리자의 키를 내려준다
  let adminKey = null;
  if (!ownKey && me.can_use_admin_key) {
    const [admin] = await sql`
      SELECT gemini_key_enc FROM users
      WHERE is_admin = true AND gemini_key_enc IS NOT NULL
      ORDER BY id LIMIT 1`;
    if (admin) adminKey = decryptSecret(admin.gemini_key_enc);
  }

  res.status(200).json({
    email: me.email,
    is_admin: me.is_admin,
    can_use_admin_key: me.can_use_admin_key,
    has_own_key: !!ownKey,
    using_admin_key: !ownKey && !!adminKey,
    gemini_key: ownKey ?? adminKey ?? "",
  });
});
