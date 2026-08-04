import { sql } from "./_db.js";

// 전송 이력 기록 등 '부가 저장'용 — 컬럼 누락(마이그레이션 미실행) 같은 이유로 실패해도
// 이미 성공한 외부 전송을 실패로 뒤집지 않는다. 실패 사유는 활동 로그에만 남긴다.
export async function tryRecord(fn, userId, what) {
  try {
    await fn();
    return true;
  } catch (e) {
    await logAct(userId, "client_error", `${what} 기록 실패(전송은 성공): ${e.message}`);
    return false;
  }
}

// 활동 로그 한 줄 기록 — 로그 실패가 본 기능을 깨뜨리지 않게 조용히 무시
export async function logAct(userId, action, detail = null) {
  try {
    await sql`
      INSERT INTO activity_log (user_id, action, detail)
      VALUES (${userId ?? null}, ${action}, ${detail ? String(detail).slice(0, 2000) : null})`;
  } catch {
    /* 로그는 부가 기능 */
  }
}
