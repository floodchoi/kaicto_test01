import { sql } from "../_db.js";
import { wrap } from "../_wrap.js";
import { requireAuth } from "../_auth.js";

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);
const KINDS = new Set(["stt", "summary"]);
const PROVIDERS = new Set(["gemini", "openai", "local"]);
const num = (v, max) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= max ? Math.round(n) : null;
};

// POST /api/usage — AI 호출 사용량 보고 (전사·요약은 브라우저→제공자 직행이라 서버는 모름)
// GET  /api/usage?from=&to= — 관리자 전용: 기간 내 사용자·종류·모델별 집계
export default wrap(async function handler(req, res) {
  const userId = requireAuth(req, res);
  if (!userId) return;

  if (req.method === "POST") {
    const b = req.body ?? {};
    if (!KINDS.has(b.kind) || !PROVIDERS.has(b.provider))
      return res.status(400).json({ error: "잘못된 사용량 보고입니다." });
    await sql`
      INSERT INTO api_usage (user_id, kind, provider, model, input_tokens, output_tokens, audio_seconds)
      VALUES (${userId}, ${b.kind}, ${b.provider}, ${String(b.model ?? "").slice(0, 80) || null},
              ${num(b.input_tokens, 1e9)}, ${num(b.output_tokens, 1e9)}, ${num(b.audio_seconds, 86400 * 2)})`;
    return res.status(200).json({ ok: true });
  }

  if (req.method !== "GET") return res.status(405).json({ error: "GET/POST only" });

  const [me] = await sql`SELECT is_admin FROM users WHERE id = ${userId}`;
  if (!me?.is_admin) return res.status(403).json({ error: "관리자만 조회할 수 있습니다." });

  const from = (req.query.from ?? "").trim();
  const to = (req.query.to ?? "").trim();
  const rows = await sql`
    SELECT u.email, a.kind, a.provider, a.model,
           count(*)::int AS calls,
           COALESCE(sum(a.input_tokens), 0)::bigint AS in_tokens,
           COALESCE(sum(a.output_tokens), 0)::bigint AS out_tokens,
           COALESCE(sum(a.audio_seconds), 0)::int AS audio_seconds
    FROM api_usage a LEFT JOIN users u ON u.id = a.user_id
    WHERE true
    ${isDate(from) ? sql`AND a.created_at >= ${from}::date` : sql``}
    ${isDate(to) ? sql`AND a.created_at < ${to}::date + 1` : sql``}
    GROUP BY u.email, a.kind, a.provider, a.model
    ORDER BY u.email NULLS LAST, a.kind`;
  res.status(200).json(rows);
});
