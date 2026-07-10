import { wrap } from "./_wrap.js";
import { checkPassword, issueToken } from "./_auth.js";

export default wrap(async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!process.env.APP_PASSWORD)
    return res.status(500).json({
      error: "서버에 APP_PASSWORD가 설정되지 않았습니다. Vercel 환경변수(또는 .env)에 추가하세요.",
    });

  const { password } = req.body ?? {};
  if (!checkPassword(password))
    return res.status(401).json({ error: "비밀번호가 올바르지 않습니다." });

  res.status(200).json({ token: issueToken() });
});
