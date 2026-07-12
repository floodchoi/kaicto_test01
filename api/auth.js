import { sql } from "./_db.js";
import { wrap } from "./_wrap.js";
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

  const { action, email: rawEmail, password, challenge, website } = req.body ?? {};
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

    const [user] = await sql`
      INSERT INTO users (email, password_hash, is_admin)
      VALUES (${email}, ${hashPassword(password)}, ${email === ADMIN_EMAIL})
      ON CONFLICT (email) DO NOTHING
      RETURNING id`;
    if (!user) return res.status(409).json({ error: "이미 가입된 이메일입니다. 로그인해주세요." });
    return res.status(200).json({ token: issueToken(user.id), email });
  }

  if (action === "login") {
    const [user] = await sql`SELECT id, password_hash FROM users WHERE email = ${email}`;
    // 미가입 이메일도 더미 해시를 검증해 응답 시간 차이(계정 존재 유추)를 줄인다
    const ok = verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
    if (!user || !ok)
      return res.status(401).json({ error: "이메일 또는 비밀번호가 올바르지 않습니다." });
    return res.status(200).json({ token: issueToken(user.id), email });
  }

  res.status(400).json({ error: "action은 signup 또는 login이어야 합니다." });
});
