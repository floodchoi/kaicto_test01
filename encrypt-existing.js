// [1회성] 암호화 도입 전에 저장된 회의록 원문을 암호화합니다. 여러 번 실행해도 안전(멱등).
// 실행: node --env-file=.env encrypt-existing.js
//   배포 DB에 적용하려면 .env의 DATABASE_URL·AUTH_SECRET을 Vercel과 동일한 값으로 잠시 바꿔 실행.
//   ⚠️ AUTH_SECRET이 Vercel과 다르면 배포된 앱이 복호화하지 못합니다.
import { sql } from "./api/_db.js";
import { encryptText } from "./api/_auth.js";

if (!process.env.AUTH_SECRET) {
  console.error("AUTH_SECRET이 없습니다. .env를 확인하세요.");
  process.exit(1);
}

const rows = await sql`SELECT id, raw_text FROM meetings WHERE raw_text NOT LIKE 'enc:%'`;
for (const r of rows) {
  await sql`UPDATE meetings SET raw_text = ${encryptText(r.raw_text)} WHERE id = ${r.id}`;
}
console.log(`완료: ${rows.length}건 암호화됨 (이미 암호화된 회의록은 건너뜀)`);
await sql.end();
