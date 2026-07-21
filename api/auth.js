import { sql } from "./_db.js";
import { wrap } from "./_wrap.js";
import { logAct } from "./_log.js";
import {
  hashPassword,
  verifyPassword,
  issueToken,
  issueChallenge,
  verifyChallenge,
  DUMMY_HASH,
  ADMIN_EMAIL,
} from "./_auth.js";

// ponytail: 인스턴스 메모리 rate limit — 완화 장치. 강한 보호가 필요하면 Vercel WAF.
const attempts = new Map(); // ip → { n, reset }
const rateLimited = (ip) => {
  const now = Date.now();
  const e = attempts.get(ip) ?? { n: 0, reset: now + 60 * 60 * 1000 };
  if (now > e.reset) {
    e.n = 0;
    e.reset = now + 60 * 60 * 1000;
  }
  e.n++;
  attempts.set(ip, e);
  return e.n > 30; // 시간당 30회
};

// GET  /api/auth → 가입 챌린지 발급
// POST /api/auth { action: "signup"|"login", email, password, challenge?, website? }
export default wrap(async function handler(req, res) {
  if (!process.env.AUTH_SECRET)
    return res.status(500).json({
      error: "서버에 AUTH_SECRET이 설정되지 않았습니다. Vercel 환경변수(또는 .env)에 추가하세요.",
    });

  if (req.method === "GET") return res.status(200).json({ challenge: issueChallenge() });
  if (req.method !== "POST") return res.status(405).json({ error: "GET/POST only" });

  const ip = (req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() || "unknown";
  if (rateLimited(ip))
    return res.status(429).json({ error: "요청이 너무 많습니다. 잠시 후 다시 시도해주세요." });

  const { action, email: rawEmail, password, challenge, website, invite } = req.body ?? {};
  const email = String(rawEmail ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254)
    return res.status(400).json({ error: "올바른 이메일 주소를 입력해주세요." });
  if (typeof password !== "string" || password.length < 8 || password.length > 200)
    return res.status(400).json({ error: "비밀번호는 8자 이상이어야 합니다." });

  if (action === "signup") {
    // 봇 방지 1: 허니팟 — 사람에겐 보이지 않는 필드. 채워져 있으면 자동 프로그램.
    if (website) return res.status(400).json({ error: "가입할 수 없습니다." });
    // 봇 방지 2: 챌린지 — 폼 표시 후 최소 3초 경과해야 제출 가능
    const reason = verifyChallenge(challenge);
    if (reason) return res.status(400).json({ error: reason });

    // 초대 코드: 유효하면 즉시 사용 가능, 비우면 관리자 승인 대기, 틀리거나 소진되면 가입 거부.
    // 코드는 DB(invite_codes)에서 관리 — 여러 개 + 코드별 최대 사용 횟수.
    const code = String(invite ?? "").trim();
    let usedCodeId = null;
    if (code) {
      // 남은 횟수가 있을 때만 원자적으로 차감 (동시 가입 경쟁에도 초과 사용 불가)
      const [row] = await sql`
        UPDATE invite_codes SET used_count = used_count + 1
        WHERE code = ${code} AND used_count < max_uses
        RETURNING id`;
      if (!row) {
        const [exists] = await sql`SELECT 1 FROM invite_codes WHERE code = ${code}`;
        return res.status(400).json({
          error: exists
            ? "이 초대 코드는 사용 횟수가 모두 소진되었습니다. 코드 없이 가입하면 관리자 승인 후 이용할 수 있습니다."
            : "초대 코드가 올바르지 않습니다. 코드 없이 가입하면 관리자 승인 후 이용할 수 있습니다.",
        });
      }
      usedCodeId = row.id;
    }

    const isAdmin = email === ADMIN_EMAIL;
    const approved = isAdmin || !!usedCodeId;

    const [user] = await sql`
      INSERT INTO users (email, password_hash, is_admin, approved)
      VALUES (${email}, ${hashPassword(password)}, ${isAdmin}, ${approved})
      ON CONFLICT (email) DO NOTHING
      RETURNING id`;
    if (!user) {
      // 중복 이메일로 가입 실패 — 차감했던 코드 사용 횟수 반환
      if (usedCodeId)
        await sql`UPDATE invite_codes SET used_count = used_count - 1 WHERE id = ${usedCodeId}`;
      return res.status(409).json({ error: "이미 가입된 이메일입니다. 로그인해주세요." });
    }

    await logAct(user.id, "signup", approved ? "즉시 사용 가능(초대 코드)" : "승인 대기");
    if (!approved)
      return res.status(200).json({
        pending: true,
        message: "가입이 접수되었습니다. 관리자 승인 후 로그인할 수 있습니다.",
      });
    return res.status(200).json({ token: issueToken(user.id), email });
  }

  if (action === "login") {
    const [user] = await sql`SELECT id, password_hash, approved FROM users WHERE email = ${email}`;
    // 미가입 이메일도 더미 해시를 검증해 응답 시간 차이(계정 존재 유추)를 줄인다
    const ok = verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
    if (!user || !ok)
      return res.status(401).json({ error: "이메일 또는 비밀번호가 올바르지 않습니다." });
    if (!user.approved)
      return res.status(403).json({ error: "관리자 승인 대기 중입니다. 승인이 완료되면 로그인할 수 있습니다." });
    await logAct(user.id, "login");
    return res.status(200).json({ token: issueToken(user.id), email });
  }

  res.status(400).json({ error: "action은 signup 또는 login이어야 합니다." });
});
