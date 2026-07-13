import {
  createCipheriv, createDecipheriv, createHash, createHmac,
  randomBytes, scryptSync, timingSafeEqual,
} from "node:crypto";

// 초기 관리자 — 이 이메일로 가입하면 자동으로 관리자 권한
export const ADMIN_EMAIL = "floodchoi@gmail.com";

// 이메일/비밀번호 인증. AUTH_SECRET(환경변수)은 토큰 서명 키 — 유출 시 전체 토큰 위조 가능하므로 비밀 유지.
const SECRET = process.env.AUTH_SECRET ?? "";

const hmac = (s) => createHmac("sha256", SECRET).update(s).digest("base64url");

// 비밀번호 해시: scrypt (Node 내장 — 외부 의존성 불필요). 저장 형식 "salt:hash" (hex)
export const hashPassword = (pw) => {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(pw, salt, 64).toString("hex")}`;
};

export const verifyPassword = (pw, stored) => {
  const [salt, hash] = (stored ?? "").split(":");
  if (!salt || !hash) return false;
  const calc = scryptSync(pw, salt, 64);
  const expect = Buffer.from(hash, "hex");
  return calc.length === expect.length && timingSafeEqual(calc, expect);
};

// 로그인 실패(미가입 이메일) 시에도 해시 검증 시간을 유사하게 유지하기 위한 더미
export const DUMMY_HASH = hashPassword("dummy-password-for-timing");

// 무상태 토큰: "<userId>.<만료ms>.<서명>" — DB 조회 없이 검증
export const issueToken = (userId) => {
  const exp = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30일
  return `${userId}.${exp}.${hmac(`${userId}.${exp}`)}`;
};

// 상수시간 문자열 비교 (해시로 길이 정규화) — 초대 코드 비교 등에 사용
export const safeEqual = (a, b) => {
  const ba = Buffer.from(hmac("cmp:" + a));
  const bb = Buffer.from(hmac("cmp:" + b));
  return timingSafeEqual(ba, bb);
};

// ── 사용자 API 키 암호화 (AES-256-GCM, 키는 AUTH_SECRET 파생) ──
// DB가 유출돼도 AUTH_SECRET 없이는 복호화 불가.
const encKey = createHash("sha256").update("enckey:" + SECRET).digest();

export const encryptSecret = (text) => {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", encKey, iv);
  const data = Buffer.concat([c.update(text, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), data].map((b) => b.toString("base64url")).join(".");
};

export const decryptSecret = (stored) => {
  try {
    const [iv, tag, data] = String(stored ?? "").split(".").map((x) => Buffer.from(x, "base64url"));
    const d = createDecipheriv("aes-256-gcm", encKey, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(data), d.final()]).toString("utf8");
  } catch {
    return null;
  }
};

// ── 가입 봇 방지용 챌린지 ─────────────────────────────────────
// 폼을 열 때 발급받아 최소 3초 뒤에만 제출 가능 (자동 프로그램의 즉시 제출 차단).
// 무상태 HMAC 서명이라 DB 불필요.
export const issueChallenge = () => {
  const ts = Date.now();
  return `${ts}.${hmac("ch:" + ts)}`;
};

// 통과 시 null, 실패 시 사유 문자열 반환
export const verifyChallenge = (challenge) => {
  const [tsStr, sig] = String(challenge ?? "").split(".");
  const ts = Number(tsStr);
  if (!Number.isFinite(ts) || !sig || !safeEqual(sig, hmac("ch:" + tsStr)))
    return "가입 확인에 실패했습니다. 페이지를 새로고침 후 다시 시도해주세요.";
  const age = Date.now() - ts;
  if (age < 3000) return "너무 빠른 요청입니다. 잠시 후 다시 시도해주세요.";
  if (age > 10 * 60 * 1000) return "가입 확인이 만료되었습니다. 페이지를 새로고침 후 다시 시도해주세요.";
  return null;
};

// 성공 시 userId(number) 반환, 실패 시 401 응답을 보내고 null 반환.
// 사용: const userId = requireAuth(req, res); if (!userId) return;
export const requireAuth = (req, res) => {
  if (!SECRET) {
    res.status(500).json({
      error: "서버에 AUTH_SECRET이 설정되지 않았습니다. Vercel 환경변수(또는 .env)에 추가하세요.",
    });
    return null;
  }
  const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  const [uidStr, expStr, sig] = token.split(".");
  const uid = Number(uidStr);
  const exp = Number(expStr);
  const valid =
    Number.isInteger(uid) && uid > 0 && exp > Date.now() && sig && safeEqual(sig, hmac(`${uidStr}.${expStr}`));
  if (!valid) {
    res.status(401).json({ error: "로그인이 필요합니다." });
    return null;
  }
  return uid;
};
