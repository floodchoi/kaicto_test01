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
  // 회의 원문은 토글 블록 안에 접어서 저장 — 페이지가 깔끔하고 필요할 때만 펼쳐 봄
  const t = String(text ?? "");
  const paras = [];
  let written = 0;
  for (; written < t.length && paras.length < 90; written += 2000) paras.push(para(t.slice(written, written + 2000)));
  if (written < t.length) paras.push(para("… (원문이 길어 일부 생략 — 웹앱에서 전체를 볼 수 있습니다)"));
  if (paras.length)
    blocks.push({
      object: "block",
      type: "toggle",
      toggle: { rich_text: rt("📄 회의 원문 (펼쳐 보기)"), children: paras },
    });
  return blocks.slice(0, 100);
}

// 토큰 유효성만 확인 (대상과 무관) — /v1/users/me 는 토큰이 유효하면 봇 정보를 반환
export async function testNotionToken(token) {
  const res = await fetch(`${BASE}/v1/users/me`, { headers: headers(token) });
  if (!res.ok) {
    const msg = (await res.json().catch(() => ({}))).message ?? `HTTP ${res.status}`;
    throw new Error(`Notion 토큰이 유효하지 않습니다: ${msg}`);
  }
  const d = await res.json().catch(() => ({}));
  return d?.name ? `토큰 유효 (통합: ${d.name})` : "토큰 유효";
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

// 페이지의 기존 본문 블록을 모두 지우고 새 블록으로 교체 (같은 페이지를 유지한 채 내용만 갱신)
async function replaceChildren(token, pageId, children) {
  const listRes = await fetch(`${BASE}/v1/blocks/${pageId}/children?page_size=100`, { headers: headers(token) });
  if (listRes.ok) {
    const old = (await listRes.json().catch(() => ({})))?.results ?? [];
    for (const b of old) {
      await fetch(`${BASE}/v1/blocks/${b.id}`, { method: "DELETE", headers: headers(token) }).catch(() => {});
    }
  }
  // 한 번에 100블록까지 — buildBlocks가 이미 100 이하로 잘라서 넘긴다
  const res = await fetch(`${BASE}/v1/blocks/${pageId}/children`, {
    method: "PATCH",
    headers: headers(token),
    body: JSON.stringify({ children }),
  });
  if (!res.ok) {
    const msg = (await res.json().catch(() => ({}))).message ?? `HTTP ${res.status}`;
    throw new Error(`본문 갱신 실패: ${msg}`);
  }
}

// 대상 DB에서 같은 회의록 ID를 가진 기존 페이지를 찾는다 (페이지 ID 기록이 없거나 유실된 경우 대비).
// ID 속성이 없는 DB면 null — 이 경우 중복 방지는 저장된 page_id에만 의존한다.
async function findPageByMeetingId(token, dbId, props, meetingId) {
  const key = Object.keys(props).find((k) => /회의록\s*id|meeting\s*id|^id$/i.test(k.trim()));
  const type = key && props[key].type;
  if (!key || (type !== "rich_text" && type !== "number")) return null;
  const filter =
    type === "number"
      ? { property: key, number: { equals: Number(meetingId) } }
      : { property: key, rich_text: { equals: "MM-" + meetingId } };
  const res = await fetch(`${BASE}/v1/databases/${dbId}/query`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({ filter, page_size: 1 }),
  });
  if (!res.ok) return null;
  const found = (await res.json().catch(() => ({})))?.results?.[0];
  return found && !found.archived ? found.id : null;
}

// 페이지가 지금 대상 DB에 살아 있는지 확인 (대상이 바뀌었거나 삭제됐으면 새로 만들어야 함)
async function pageUsable(token, pageId, dbId) {
  const res = await fetch(`${BASE}/v1/pages/${pageId}`, { headers: headers(token) });
  if (!res.ok) return false;
  const p = await res.json().catch(() => ({}));
  if (p.archived || p.in_trash) return false;
  if (!dbId) return true; // 페이지 하위 저장 방식
  return extractNotionId(p.parent?.database_id ?? "") === dbId;
}

// 회의록을 Notion에 저장 — 기존 페이지가 있으면 그 페이지를 업데이트(중복 생성 없음),
// 없으면 새로 생성. DB면 제목/태그/날짜/프로젝트/ID 속성을 자동 매핑, 페이지면 하위 페이지.
export async function pushToNotion({ token, targetId, targetType }, meeting, existingPageId) {
  const id = extractNotionId(targetId);
  const children = buildBlocks(meeting);
  let body;
  let properties;
  let pageToUpdate = null;

  if (targetType === "page") {
    if (existingPageId && (await pageUsable(token, existingPageId, null))) pageToUpdate = existingPageId;
    properties = { title: { title: rt(meeting.title) } };
    body = { parent: { page_id: id }, properties, children };
  } else {
    // DB 스키마를 조회해 제목·태그(multi_select)·날짜(date) 속성 이름을 자동 탐색
    const dbRes = await fetch(`${BASE}/v1/databases/${id}`, { headers: headers(token) });
    if (!dbRes.ok) throw new Error(`데이터베이스 조회 실패 (HTTP ${dbRes.status})`);
    const props = (await dbRes.json()).properties ?? {};
    const findProp = (type) => Object.keys(props).find((k) => props[k].type === type);
    properties = { [findProp("title") ?? "Name"]: { title: rt(meeting.title) } };
    const tagProp = findProp("multi_select");
    if (tagProp && meeting.tags?.length)
      properties[tagProp] = {
        multi_select: meeting.tags.slice(0, 10).map((t) => ({ name: String(t).slice(0, 90) })),
      };
    // 날짜 속성 분리 매핑: '날짜/회의' 이름의 date 속성 ← 회의록 생성일,
    // '생성일/업로드/created' 이름의 date 속성 ← 전송(업로드) 시점. 하나뿐이면 회의록 생성일.
    const dateKeys = Object.keys(props).filter((k) => props[k].type === "date");
    const uploadDateProp = dateKeys.find((k) => /생성일|업로드|created/i.test(k));
    const meetingDateProp =
      dateKeys.find((k) => /날짜|회의|meeting|date/i.test(k) && k !== uploadDateProp) ??
      dateKeys.find((k) => k !== uploadDateProp);
    if (meetingDateProp)
      properties[meetingDateProp] = {
        // Notion 페이지 생성 시각이 아니라 회의록 생성일 (소급 전송해도 원래 날짜 유지)
        date: { start: meeting.createdAt ? new Date(meeting.createdAt).toISOString() : new Date().toISOString() },
      };
    if (uploadDateProp)
      properties[uploadDateProp] = { date: { start: new Date().toISOString() } };
    // 프로젝트 이름: '프로젝트'/'Project' 이름의 속성 우선, 없으면 첫 select 속성에 매핑
    if (meeting.project) {
      const byName = Object.keys(props).find((k) => /^(프로젝트|project)$/i.test(k.trim()));
      const key = byName ?? findProp("select");
      const t = key && props[key].type;
      if (t === "select") properties[key] = { select: { name: String(meeting.project).slice(0, 90) } };
      else if (t === "rich_text") properties[key] = { rich_text: rt(meeting.project) };
    }
    // 회의록 ID: '회의록 ID'/'Meeting ID'/'ID' 이름의 속성이 있으면 채움 (없으면 본문에만 기록)
    if (meeting.meetingId != null) {
      const key = Object.keys(props).find((k) => /회의록\s*id|meeting\s*id|^id$/i.test(k.trim()));
      const t = key && props[key].type;
      if (t === "number") properties[key] = { number: Number(meeting.meetingId) };
      else if (t === "rich_text") properties[key] = { rich_text: rt("MM-" + meeting.meetingId) };
    }
    body = { parent: { database_id: id }, properties, children };

    // 업데이트할 기존 페이지 찾기: 저장된 page_id가 이 DB에 살아 있으면 그것을,
    // 없으면 같은 회의록 ID를 가진 행을 찾아 재사용 (중복 행 생성 방지)
    if (existingPageId && (await pageUsable(token, existingPageId, id))) pageToUpdate = existingPageId;
    else if (meeting.meetingId != null) pageToUpdate = await findPageByMeetingId(token, id, props, meeting.meetingId);
  }

  // 기존 페이지가 있으면 속성 + 본문을 갱신 (새 페이지를 만들지 않는다)
  if (pageToUpdate) {
    const upd = await fetch(`${BASE}/v1/pages/${pageToUpdate}`, {
      method: "PATCH",
      headers: headers(token),
      body: JSON.stringify({ properties }),
    });
    if (!upd.ok) {
      const msg = (await upd.json().catch(() => ({}))).message ?? `HTTP ${upd.status}`;
      throw new Error(`페이지 속성 갱신 실패: ${msg}`);
    }
    await replaceChildren(token, pageToUpdate, children);
    const page = await upd.json().catch(() => ({}));
    return { url: page.url ?? null, pageId: pageToUpdate, updated: true };
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
  const created = await res.json();
  return { url: created.url ?? null, pageId: created.id ?? null, updated: false };
}

// 페이지 보관(휴지통) 처리 — 중복 정리에 사용. Notion에서 되돌릴 수 있다.
export async function archiveNotionPage(token, pageId) {
  const res = await fetch(`${BASE}/v1/pages/${pageId}`, {
    method: "PATCH",
    headers: headers(token),
    body: JSON.stringify({ archived: true }),
  });
  return res.ok;
}

// 대상 DB에서 같은 '회의록 ID'를 가진 중복 행을 찾는다.
// 반환: { key, groups: [{ meetingId, pages: [{id, url, lastEdited}] }] } — pages는 최신순
export async function findNotionDuplicates(token, targetId) {
  const id = extractNotionId(targetId);
  const dbRes = await fetch(`${BASE}/v1/databases/${id}`, { headers: headers(token) });
  if (!dbRes.ok) throw new Error(`데이터베이스 조회 실패 (HTTP ${dbRes.status})`);
  const props = (await dbRes.json()).properties ?? {};
  const key = Object.keys(props).find((k) => /회의록\s*id|meeting\s*id|^id$/i.test(k.trim()));
  const type = key && props[key].type;
  if (!key || (type !== "rich_text" && type !== "number"))
    throw new Error(
      "이 데이터베이스에는 '회의록 ID' 속성(텍스트 또는 숫자)이 없어 중복을 식별할 수 없습니다 — 속성을 추가하고 회의록을 다시 전송한 뒤 이용하세요.",
    );

  const byId = new Map();
  let cursor;
  for (let page = 0; page < 20; page++) { // 최대 2000행
    const res = await fetch(`${BASE}/v1/databases/${id}/query`, {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify({ page_size: 100, ...(cursor && { start_cursor: cursor }) }),
    });
    if (!res.ok) throw new Error(`데이터베이스 조회 실패 (HTTP ${res.status})`);
    const j = await res.json();
    for (const p of j.results ?? []) {
      if (p.archived || p.in_trash) continue;
      const prop = p.properties?.[key];
      const v =
        type === "number"
          ? prop?.number
          : (prop?.rich_text ?? []).map((t) => t.plain_text ?? t.text?.content ?? "").join("").trim();
      if (v === null || v === undefined || v === "") continue;
      const k = String(v);
      if (!byId.has(k)) byId.set(k, []);
      byId.get(k).push({ id: p.id, url: p.url ?? null, lastEdited: p.last_edited_time ?? "" });
    }
    if (!j.has_more) break;
    cursor = j.next_cursor;
  }

  const groups = [];
  for (const [meetingId, pages] of byId) {
    if (pages.length < 2) continue;
    pages.sort((a, b) => String(b.lastEdited).localeCompare(String(a.lastEdited))); // 최신 먼저
    groups.push({ meetingId, pages });
  }
  return { key, groups };
}
