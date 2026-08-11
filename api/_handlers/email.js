import nodemailer from "nodemailer";
import { sql } from "../_db.js";
import { wrap } from "../_wrap.js";
import { requireAuth, decryptSecret, decryptText } from "../_auth.js";
import { seeCond } from "../meetings.js";
import { logAct } from "../_log.js";

const esc = (s) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// 회의록 → 이메일 본문 (HTML + 평문 대체본)
function buildMail(m) {
  const li = (arr, fn) => (arr ?? []).map(fn).join("");
  const html = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:680px;color:#334155">
  <h1 style="font-size:20px;color:#0f172a;margin:0 0 4px">${esc(m.title)}</h1>
  <p style="font-size:13px;color:#94a3b8;margin:0 0 20px">
    ${new Date(m.created_at).toLocaleDateString("ko-KR")}${m.project ? ` · ${esc(m.project)}` : ""}
  </p>
  ${m.summary?.length ? `<h2 style="font-size:15px;color:#0f766e">3줄 요약</h2><ul style="padding-left:18px">${li(m.summary, (s) => `<li style="margin:4px 0">${esc(s)}</li>`)}</ul>` : ""}
  ${m.agenda?.length ? `<h2 style="font-size:15px;color:#0f766e">주요 아젠다</h2>${li(m.agenda, (a) => `<div style="border-left:3px solid #99f6e4;padding-left:12px;margin:10px 0"><b>${esc(a.topic)}</b><br><span style="font-size:14px">${esc(a.discussion)}</span></div>`)}` : ""}
  ${m.action_items?.length ? `<h2 style="font-size:15px;color:#0f766e">액션 아이템</h2><ul style="padding-left:18px">${li(m.action_items, (a) => `<li style="margin:4px 0">${a.done ? "✅ " : "☐ "}${esc(a.task)}${a.assignee ? ` <span style="color:#94a3b8">(담당 ${esc(a.assignee)})</span>` : ""}${a.due_date ? ` <span style="color:#94a3b8">(기한 ${esc(a.due_date)})</span>` : ""}</li>`)}</ul>` : ""}
  ${m.tags?.length ? `<p style="font-size:13px;color:#94a3b8">태그: ${esc(m.tags.join(", "))}</p>` : ""}
  ${m.includeRaw && m.text ? `<h2 style="font-size:15px;color:#0f766e">회의 원문</h2><pre style="white-space:pre-wrap;font-family:inherit;font-size:13px;background:#f8fafc;padding:12px;border-radius:8px">${esc(m.text)}</pre>` : ""}
  <p style="font-size:12px;color:#cbd5e1;margin-top:24px">📝 Meeting Minutes에서 보냈습니다.</p>
</div>`;
  const text = [
    m.title,
    new Date(m.created_at).toLocaleDateString("ko-KR"),
    m.summary?.length ? "\n[3줄 요약]\n" + m.summary.map((s) => "- " + s).join("\n") : "",
    m.agenda?.length ? "\n[주요 아젠다]\n" + m.agenda.map((a) => `- ${a.topic}: ${a.discussion}`).join("\n") : "",
    m.action_items?.length
      ? "\n[액션 아이템]\n" +
        m.action_items
          .map((a) => `- ${a.done ? "[완료] " : ""}${a.task}${a.assignee ? ` (담당 ${a.assignee})` : ""}${a.due_date ? ` (기한 ${a.due_date})` : ""}`)
          .join("\n")
      : "",
    m.tags?.length ? "\n태그: " + m.tags.join(", ") : "",
    m.includeRaw && m.text ? "\n[회의 원문]\n" + m.text : "",
  ].filter(Boolean).join("\n");
  return { html, text };
}

const makeTransport = (cfg) =>
  nodemailer.createTransport({
    host: cfg.smtp_host,
    port: cfg.smtp_port ?? 587,
    secure: (cfg.smtp_port ?? 587) === 465, // 465=SSL, 그 외는 STARTTLS
    auth: cfg.smtp_user ? { user: cfg.smtp_user, pass: decryptSecret(cfg.smtp_pass_enc) } : undefined,
  });

// POST /api/email
//  { action: "test" }                         → 내 주소로 테스트 메일
//  { action: "send", meetingId, to, includeRaw } → 회의록 발송 (to 비우면 가입 이메일)
export default wrap(async function handler(req, res) {
  const userId = requireAuth(req, res);
  if (!userId) return;
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  let me;
  try {
    [me] = await sql`
      SELECT email, smtp_host, smtp_port, smtp_user, smtp_pass_enc, smtp_from FROM users WHERE id = ${userId}`;
  } catch (e) {
    if (/does not exist/i.test(e.message))
      return res.status(400).json({
        error: "DB 마이그레이션이 필요합니다 — 화면 상단 배너의 [🔧 마이그레이션 실행 (관리자)]을 눌러주세요.",
      });
    throw e;
  }
  if (!me?.smtp_host)
    return res.status(400).json({ error: "먼저 ⚙️ 설정에서 이메일(SMTP) 서버를 등록해주세요." });

  const from = me.smtp_from?.trim() || me.smtp_user || me.email;
  const transport = makeTransport(me);

  if (req.body?.action === "test") {
    try {
      await transport.sendMail({
        from, to: me.email,
        subject: "[Meeting Minutes] 이메일 설정 테스트",
        text: "이 메일이 보인다면 SMTP 설정이 정상입니다.",
      });
      await logAct(userId, "email_send", `설정 테스트 → ${me.email}`);
      return res.status(200).json({ ok: true, to: me.email });
    } catch (e) {
      await logAct(userId, "email_error", `설정 테스트: ${e.message}`);
      return res.status(400).json({ error: `발송 실패: ${e.message}` });
    }
  }

  if (req.body?.action !== "send") return res.status(400).json({ error: "action은 send 또는 test여야 합니다." });

  // 수신자: 지정값(쉼표 구분, 최대 10명) 또는 기본값 = 가입 이메일
  const raw = String(req.body?.to ?? "").trim();
  const to = (raw ? raw.split(/[,;\s]+/).filter(Boolean) : [me.email]).slice(0, 10);
  if (to.some((a) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a)))
    return res.status(400).json({ error: "이메일 주소 형식이 올바르지 않습니다." });

  const meetingId = Number(req.body?.meetingId);
  const [m] = await sql`
    SELECT m.*, p.name AS project_name FROM meetings m
    LEFT JOIN projects p ON p.id = m.project_id
    WHERE m.id = ${meetingId} AND ${seeCond(userId)}`;
  if (!m) return res.status(404).json({ error: "회의록을 찾을 수 없습니다." });
  const items = await sql`
    SELECT task, assignee, due_date, done FROM action_items WHERE meeting_id = ${meetingId} ORDER BY id`;

  const { html, text } = buildMail({
    title: m.title,
    created_at: m.created_at,
    project: m.project_name,
    summary: m.summary ?? [],
    agenda: m.agenda ?? [],
    action_items: items,
    tags: m.tags ?? [],
    text: decryptText(m.raw_text),
    includeRaw: req.body?.includeRaw !== false,
  });

  try {
    await transport.sendMail({ from, to: to.join(", "), subject: `[회의록] ${m.title}`, html, text });
    await logAct(userId, "email_send", `#${meetingId} ${m.title} → ${to.join(", ")}`);
    return res.status(200).json({ ok: true, to });
  } catch (e) {
    await logAct(userId, "email_error", `#${meetingId} ${e.message}`);
    return res.status(400).json({ error: `발송 실패: ${e.message}` });
  }
});
