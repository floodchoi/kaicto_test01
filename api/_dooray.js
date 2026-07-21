// Dooray 연동 — 회의록 저장 시 액션 아이템을 지정 프로젝트의 업무(task)로 등록.
// Dooray API도 토큰이 필요해 서버(여기)가 대신 호출한다.
const BASE = process.env.DOORAY_API_BASE ?? "https://api.dooray.com";

const headers = (token) => ({
  Authorization: `dooray-api ${token}`,
  "Content-Type": "application/json",
});

// 연결 테스트: 프로젝트 조회
export async function testDooray({ token, projectId }) {
  const res = await fetch(`${BASE}/project/v1/projects/${encodeURIComponent(projectId)}`, {
    headers: headers(token),
  });
  if (!res.ok)
    throw new Error(
      `Dooray 접근 실패 (HTTP ${res.status}) — API 토큰과 프로젝트 ID를 확인하세요.`,
    );
  const data = await res.json().catch(() => ({}));
  return data?.result?.code ?? data?.result?.name ?? "프로젝트 확인됨";
}

// 액션 아이템들을 업무로 등록 (아이템당 1건, 최대 20건)
export async function pushTasksToDooray({ token, projectId }, meeting) {
  const items = (meeting.action_items ?? []).filter((a) => a.task?.trim()).slice(0, 20);
  if (!items.length) return { created: 0, failed: 0 };
  let created = 0;
  const errors = [];
  for (const a of items) {
    const content =
      `회의록: ${meeting.title}\n` +
      (a.assignee ? `담당(회의 기준): ${a.assignee}\n` : "") +
      (a.due_date ? `기한(회의 기준): ${a.due_date}\n` : "") +
      `\n— Meeting Minutes에서 자동 등록`;
    const res = await fetch(`${BASE}/project/v1/projects/${encodeURIComponent(projectId)}/posts`, {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify({
        subject: String(a.task).slice(0, 200),
        body: { mimeType: "text/x-markdown", content },
      }),
    });
    if (res.ok) created++;
    else errors.push(`"${String(a.task).slice(0, 20)}" HTTP ${res.status}`);
  }
  if (!created && errors.length) throw new Error(errors[0]);
  return { created, failed: errors.length };
}
