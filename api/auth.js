import { sql } from "./_db.js";
import { wrap } from "./_wrap.js";
import { hashPassword, verifyPassword, issueToken, DUMMY_HASH } from "./_auth.js";

// POST /api/auth  { action: "signup" | "login", email, password }
export default wrap(async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!process.env.AUTH_SECRET)
    return res.status(500).json({
      error: "서버에 AUTH_SECRET이 설정되지 않았습니다. Vercel 환경변수(또는 .env)에 추가하세요.",
    });

  const { action, email: rawEmail, password } = req.body ?? {};
  const email = String(rawEmail ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254)
    return res.status(400).json({ error: "올바른 이메일 주소를 입력해주세요." });
  if (typeof password !== "string" || password.length < 8 || password.length > 200)
    return res.status(400).json({ error: "비밀번호는 8자 이상이어야 합니다." });

  if (action === "signup") {
    const [user] = await sql`
      INSERT INTO users (email, password_hash)
      VALUES (${email}, ${hashPassword(password)})
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
