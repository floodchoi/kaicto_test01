import { createHmac, timingSafeEqual } from "node:crypto";

// 공유 비밀번호 방식 로그인. APP_PASSWORD(환경변수)가 곧 비밀번호이자 토큰 서명 키.
// ponytail: 다중 사용자 계정이 필요해지면 users 테이블 + bcrypt로 교체.
const SECRET = process.env.APP_PASSWORD ?? "";

const hmac = (s) => createHmac("sha256", SECRET).update(s).digest("base64url");

// 상수시간 비교 (문자열 길이 차이로 새는 것 방지 위해 해시끼리 비교)
const safeEqual = (a, b) => {
  const ba = Buffer.from(hmac("cmp:" + a));
  const bb = Buffer.from(hmac("cmp:" + b));
  return ba.length === bb.length && timingSafeEqual(ba, bb);
};

export const checkPassword = (pw) => !!SECRET && safeEqual(String(pw ?? ""), SECRET);

// 무상태 토큰: "<만료시각>.<서명>" — DB 없이 검증 가능
export const issueToken = () => {
  const exp = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30일
  return `${exp}.${hmac("tok:" + exp)}`;
};

// 실패 시 응답까지 보내고 false 반환. 핸들러 첫 줄에서: if (!requireAuth(req,res)) return;
export const requireAuth = (req, res) => {
  if (!SECRET) {
    res.status(500).json({
      error: "서버에 APP_PASSWORD가 설정되지 않았습니다. Vercel 환경변수(또는 .env)에 추가하세요.",
    });
    return false;
  }
  const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  const [expStr, sig] = token.split(".");
  const exp = Number(expStr);
  if (!(exp > Date.now()) || !sig || !safeEqual(sig, hmac("tok:" + exp))) {
    res.status(401).json({ error: "로그인이 필요합니다." });
    return false;
  }
  return true;
};
