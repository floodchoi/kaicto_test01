// 소형 엔드포인트 묶음 디스패처 — Vercel Hobby 플랜의 서버리스 함수 12개 제한 대응.
// vercel.json rewrites가 /api/users 등 원래 경로를 /api/misc?fn=… 으로 매핑한다.
// 새 엔드포인트를 추가할 땐 api/_handlers/에 두고 여기와 vercel.json에 한 줄씩 추가할 것.
import users from "./_handlers/users.js";
import log from "./_handlers/log.js";
import usage from "./_handlers/usage.js";
import integrations from "./_handlers/integrations.js";
import inviteCodes from "./_handlers/invite-codes.js";
import migrate from "./_handlers/migrate.js";
import email from "./_handlers/email.js";

const FN = {
  users,
  log,
  usage,
  integrations,
  "invite-codes": inviteCodes,
  migrate,
  email,
};

export default async function handler(req, res) {
  const fn = FN[req.query?.fn];
  if (!fn) return res.status(404).json({ error: "not found" });
  return fn(req, res);
}
