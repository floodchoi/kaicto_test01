import { sql } from "./_db.js";

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
