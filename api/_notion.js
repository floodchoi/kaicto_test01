// Notion 연동 — 회의록 저장 시 지정된 데이터베이스/페이지에 자동 기록.
// Notion API는 브라우저 CORS를 막아 서버(여기)가 대신 호출한다.
const BASE = process.env.NOTION_API_BASE ?? "https://api.notion.com";

const headers = (token) => ({
  Authorization: `Bearer ${token}`,
  "Notion-Version": "2022-06-28",
  "Content-Type": "application/json",
});

// Notion URL을 붙여넣어도 되게 마지막 32자리 hex ID를 추출 (하이픈 유무 무관)
export const extractNotionId = (s) =>
  String(s ?? "").replace(/-/g, "").match(/[0-9a-f]{32}/gi)?.pop() ?? String(s ?? "").trim();

const rt = (text) => [{ type: "text", text: { content: String(text).slice(0, 2000) } }];
const heading = (t) => ({ object: "block", type: "heading_2", heading_2: { rich_text: rt(t) } });
const para = (t) => ({ object: "block", type: "paragraph", paragraph: { rich_text: rt(t) } });
const bullet = (t) => ({ object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: rt(t) } });
const todo = (t, checked) => ({ object: "block", type: "to_do", to_do: { rich_text: rt(t), checked: !!checked } });

// 회의록 → Notion 블록 (요약·아젠다·액션 아이템·태그·원문). 최대 100블록 제한 준수.
export function buildBlocks({ summary, agenda, action_items, tags, text }) {
  const blocks = [];
  if (summary?.length) {
    blocks.push(heading("3줄 요약"));
    summary.forEach((s) => blocks.push(bullet(s)));
  }
  if (agenda?.length) {
    blocks.push(heading("주요 아젠다"));
    agenda.forEach((a) => blocks.push(bullet(`${a.topic ?? ""}${a.discussion ? ` — ${a.discussion}` : ""}`)));
  }
  if (action_items?.length) {
    blocks.push(heading("액션 아이템"));
    action_items.forEach((a) =>
      blocks.push(
        todo(
          `${a.task}${a.assignee ? ` (담당: ${a.assignee})` : ""}${a.due_date ? ` (기한: ${a.due_date})` : ""}`,
          a.done,
        ),
      ),
    );
  }
  if (tags?.length) blocks.push(para("태그: " + tags.join(", ")));
  blocks.push(heading("회의 원문"));
  const t = String(text ?? "");
  let written = 0;
  for (; written < t.length && blocks.length < 98; written += 2000) blocks.push(para(t.slice(written, written + 2000)));
  if (written < t.length) blocks.push(para("… (원문이 길어 일부 생략 — 웹앱에서 전체를 볼 수 있습니다)"));
  return blocks.slice(0, 100);
}

// 연결 테스트: 대상(DB/페이지)에 접근 가능한지 확인, 제목 반환
export async function testNotion({ token, targetId, targetType }) {
  const id = extractNotionId(targetId);
  const url =
    targetType === "page" ? `${BASE}/v1/pages/${id}` : `${BASE}/v1/databases/${id}`;
  const res = await fetch(url, { headers: headers(token) });
  if (!res.ok) {
    const msg = (await res.json().catch(() => ({}))).message ?? `HTTP ${res.status}`;
    throw new Error(
      `Notion 접근 실패: ${msg} — 토큰·대상 ID를 확인하고, Notion에서 해당 페이지/DB를 통합(integration)에 공유했는지 확인하세요.`,
    );
  }
  const data = await res.json();
  const title =
    targetType === "page"
      ? "페이지 확인됨"
      : (data.title?.map((t) => t.plain_text).join("") || "제목 없는 데이터베이스");
  return title;
}

// 회의록을 Notion에 저장 — DB면 행 추가(제목/태그/날짜 속성 자동 매핑), 페이지면 하위 페이지 생성
export async function pushToNotion({ token, targetId, targetType }, meeting) {
  const id = extractNotionId(targetId);
  const children = buildBlocks(meeting);
  let body;
  if (targetType === "page") {
    body = {
      parent: { page_id: id },
      properties: { title: { title: rt(meeting.title) } },
      children,
    };
  } else {
    // DB 스키마를 조회해 제목·태그(multi_select)·날짜(date) 속성 이름을 자동 탐색
    const dbRes = await fetch(`${BASE}/v1/databases/${id}`, { headers: headers(token) });
    if (!dbRes.ok) throw new Error(`데이터베이스 조회 실패 (HTTP ${dbRes.status})`);
    const props = (await dbRes.json()).properties ?? {};
    const findProp = (type) => Object.keys(props).find((k) => props[k].type === type);
    const properties = { [findProp("title") ?? "Name"]: { title: rt(meeting.title) } };
    const tagProp = findProp("multi_select");
    if (tagProp && meeting.tags?.length)
      properties[tagProp] = {
        multi_select: meeting.tags.slice(0, 10).map((t) => ({ name: String(t).slice(0, 90) })),
      };
    const dateProp = findProp("date");
    if (dateProp) properties[dateProp] = { date: { start: new Date().toISOString() } };
    body = { parent: { database_id: id }, properties, children };
  }
  const res = await fetch(`${BASE}/v1/pages`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const msg = (await res.json().catch(() => ({}))).message ?? `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return (await res.json()).url ?? null;
}
