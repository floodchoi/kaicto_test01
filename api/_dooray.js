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

// 회의록 전체 → 마크다운 (위키 페이지 본문)
const meetingToMarkdown = (m) =>
  [
    m.summary?.length ? "## 3줄 요약\n" + m.summary.map((s) => `- ${s}`).join("\n") : "",
    m.agenda?.length
      ? "## 주요 아젠다\n" + m.agenda.map((a) => `- **${a.topic ?? ""}** — ${a.discussion ?? ""}`).join("\n")
      : "",
    m.action_items?.length
      ? "## 액션 아이템\n" +
        m.action_items
          .map(
            (a) =>
              `- [${a.done ? "x" : " "}] ${a.task}${a.assignee ? ` (담당: ${a.assignee})` : ""}${a.due_date ? ` (기한: ${a.due_date})` : ""}`,
          )
          .join("\n")
      : "",
    m.tags?.length ? `태그: ${m.tags.join(", ")}` : "",
    m.meetingId != null ? `회의록 ID: MM-${m.meetingId}` : "",
    "## 회의 원문\n" + String(m.text ?? ""),
  ]
    .filter(Boolean)
    .join("\n\n");

// 회의록 본문을 프로젝트 위키에 페이지로 저장.
// 위키 ID는 위키 목록에서 해당 프로젝트의 것을 찾아 사용한다.
export async function pushWikiToDooray({ token, projectId }, meeting) {
  const listRes = await fetch(`${BASE}/wiki/v1/wikis?page=0&size=200`, { headers: headers(token) });
  if (!listRes.ok) throw new Error(`위키 목록 조회 실패 (HTTP ${listRes.status})`);
  const wikis = (await listRes.json().catch(() => ({})))?.result ?? [];
  const wiki = wikis.find((w) => String(w?.project?.id ?? w?.projectId ?? "") === String(projectId));
  if (!wiki) throw new Error(`Dooray 프로젝트(${projectId})의 위키를 찾을 수 없습니다 — 위키 사용 설정과 토큰 권한을 확인하세요.`);

  const homePageId = wiki?.home?.pageId ?? wiki?.homePageId ?? null;
  const res = await fetch(`${BASE}/wiki/v1/wikis/${wiki.id}/pages`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({
      subject: String(meeting.title).slice(0, 200),
      body: { mimeType: "text/x-markdown", content: meetingToMarkdown(meeting) },
      ...(homePageId && { parentPageId: homePageId }),
    }),
  });
  if (!res.ok) {
    const msg = (await res.json().catch(() => ({})))?.header?.resultMessage ?? `HTTP ${res.status}`;
    throw new Error(`위키 페이지 생성 실패: ${msg}`);
  }
  return true;
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
      (meeting.meetingId != null ? `회의록 ID: MM-${meeting.meetingId}\n` : "") +
      (meeting.project ? `프로젝트: ${meeting.project}\n` : "") +
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
