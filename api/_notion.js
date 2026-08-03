// Notion 연동 — 회의록 저장 시 지정된 데이터베이스/페이지에 자동 기록.
// Notion API는 브라우저 CORS를 막아 서버(여기)가 대신 호출한다.
const BASE = process.env.NOTION_API_BASE ?? "https://api.notion.com";

const headers = (token) => ({
  Authorization: `Bearer ${token}`,
  "Notion-Version": "2022-06-28",
  "Content-Type": "application/json",
});

// Notion URL을 붙여넣어도 되게 32자리 hex ID를 추출 (하이픈 유무 무관).
// ⚠️ 데이터베이스 URL은 "…/<DB ID>?v=<뷰 ID>" 형태 — 쿼리스트링(?v=…)의 뷰 ID를
// 집지 않도록 경로에서 먼저 찾고, 경로에 없을 때만(?p=… 모달 URL) 쿼리에서 찾는다.
export const extractNotionId = (s) => {
  const str = String(s ?? "").trim();
  const [path, query = ""] = str.split("?");
  // 대시를 먼저 지우면 제목 슬러그의 hex 글자가 ID에 붙을 수 있어, 원문에서
  // UUID(8-4-4-4-12) 또는 연속 32hex 패턴을 그대로 찾은 뒤 대시만 제거한다.
  const find = (x) =>
    x.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32}/i)?.[0]
      ?.replace(/-/g, "");
  return find(path) ?? find(query) ?? str;
};

const rt = (text) => [{ type: "text", text: { content: String(text).slice(0, 2000) } }];
const heading = (t) => ({ object: "block", type: "heading_2", heading_2: { rich_text: rt(t) } });
const para = (t) => ({ object: "block", type: "paragraph", paragraph: { rich_text: rt(t) } });
const bullet = (t) => ({ object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: rt(t) } });
const todo = (t, checked) => ({ object: "block", type: "to_do", to_do: { rich_text: rt(t), checked: !!checked } });

// 회의록 → Notion 블록 (요약·아젠다·액션 아이템·태그·원문). 최대 100블록 제한 준수.
export function buildBlocks({ summary, agenda, action_items, tags, text, project, meetingId }) {
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
  if (project) blocks.push(para("프로젝트: " + project));
  if (tags?.length) blocks.push(para("태그: " + tags.join(", ")));
  if (meetingId != null) blocks.push(para("회의록 ID: MM-" + meetingId));
  blocks.push(heading("회의 원문"));
  const t = String(text ?? "");
  let written = 0;
  for (; written < t.length && blocks.length < 98; written += 2000) blocks.push(para(t.slice(written, written + 2000)));
  if (written < t.length) blocks.push(para("… (원문이 길어 일부 생략 — 웹앱에서 전체를 볼 수 있습니다)"));
  return blocks.slice(0, 100);
}

// 연결 테스트: 대상(DB/페이지)에 접근 가능한지 확인, 제목 반환.
// 못 찾으면 반대 유형으로도 조회해 "유형이 잘못됐다"까지 짚어준다.
export async function testNotion({ token, targetId, targetType }) {
  const id = extractNotionId(targetId);
  const get = (kind) =>
    fetch(`${BASE}/v1/${kind === "page" ? "pages" : "databases"}/${id}`, { headers: headers(token) });

  const res = await get(targetType === "page" ? "page" : "database");
  if (res.ok) {
    const data = await res.json();
    return targetType === "page"
      ? "페이지 확인됨"
      : (data.title?.map((t) => t.plain_text).join("") || "제목 없는 데이터베이스");
  }

  // 진단: 같은 ID가 반대 유형으로는 조회되는가? (페이지 URL을 DB로 등록한 흔한 실수)
  const other = await get(targetType === "page" ? "database" : "page").catch(() => null);
  if (other?.ok) {
    throw new Error(
      targetType === "page"
        ? "입력한 ID는 페이지가 아니라 데이터베이스입니다 — 설정에서 유형을 '데이터베이스에 행 추가'로 바꿔주세요."
        : "입력한 ID는 데이터베이스가 아니라 일반 페이지입니다 — 데이터베이스를 '전체 페이지로 열기'한 뒤 그 URL을 붙여넣거나, 유형을 '페이지 아래 하위 페이지'로 바꿔주세요.",
    );
  }

  const msg = (await res.json().catch(() => ({}))).message ?? `HTTP ${res.status}`;
  throw new Error(
    `Notion 접근 실패: ${msg} — ① Notion에서 대상(또는 그 상위 페이지)을 열고 ⋯ → 연결에 이 통합을 추가했는지, ② 데이터베이스라면 '전체 페이지로 열기' 상태의 URL을 넣었는지 확인하세요.`,
  );
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
    // 프로젝트 이름: '프로젝트'/'Project' 이름의 속성 우선, 없으면 첫 select 속성에 매핑
    if (meeting.project) {
      const byName = Object.keys(props).find((k) => /^(프로젝트|project)$/i.test(k.trim()));
      const key = byName ?? findProp("select");
      const t = key && props[key].type;
      if (t === "select") properties[key] = { select: { name: String(meeting.project).slice(0, 90) } };
      else if (t === "rich_text") properties[key] = { rich_text: rt(meeting.project) };
    }
    // 회의록 ID: '회의록 ID'/'Meeting ID' 이름의 속성이 있으면 채움 (없으면 본문에만 기록)
    if (meeting.meetingId != null) {
      const key = Object.keys(props).find((k) => /회의록\s*id|meeting\s*id/i.test(k));
      const t = key && props[key].type;
      if (t === "number") properties[key] = { number: Number(meeting.meetingId) };
      else if (t === "rich_text") properties[key] = { rich_text: rt("MM-" + meeting.meetingId) };
    }
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
