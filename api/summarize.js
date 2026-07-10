export const config = { maxDuration: 60 };

const SYSTEM_PROMPT = `너는 회의록 정리 전문가다. 사용자가 준 회의 스크립트를 분석해서 JSON으로 정리한다.
규칙:
- summary: 회의 전체를 정확히 3문장으로 요약 (한 문장 = 배열 원소 하나)
- agenda: 주요 아젠다별로 topic(짧은 제목)과 discussion(논의 내용 2~3문장 요약)
- action_items: 후속 업무. assignee는 원문에 언급된 담당자만, 없으면 null. due_date는 원문의 기한 표현 그대로("7월 15일", "다음 주" 등), 없으면 null.
- tags: 회의 주제를 나타내는 태그 2~5개 (한국어, 짧게)
- 원문에 없는 내용을 지어내지 않는다.`;

// Gemini structured output 스키마 (OpenAPI 서브셋, 타입 대문자)
const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    summary: { type: "ARRAY", items: { type: "STRING" } },
    agenda: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { topic: { type: "STRING" }, discussion: { type: "STRING" } },
        required: ["topic", "discussion"],
        propertyOrdering: ["topic", "discussion"],
      },
    },
    action_items: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          task: { type: "STRING" },
          assignee: { type: "STRING", nullable: true },
          due_date: { type: "STRING", nullable: true },
        },
        required: ["task", "assignee", "due_date"],
        propertyOrdering: ["task", "assignee", "due_date"],
      },
    },
    tags: { type: "ARRAY", items: { type: "STRING" } },
  },
  required: ["summary", "agenda", "action_items", "tags"],
  propertyOrdering: ["summary", "agenda", "action_items", "tags"],
};

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { title, text, apiKey, model } = req.body ?? {};
  if (!title?.trim() || !text?.trim())
    return res.status(400).json({ error: "title과 text는 필수입니다." });
  if (!apiKey?.trim())
    return res.status(400).json({ error: "Gemini API 키가 없습니다. 설정에서 입력해주세요." });
  // 모델은 URL 경로에 들어가므로 형식 검증
  if (!/^gemini-[a-z0-9.-]+$/.test(model ?? ""))
    return res.status(400).json({ error: "유효하지 않은 모델입니다." });

  const gemRes = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ parts: [{ text }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: RESPONSE_SCHEMA,
        },
      }),
    },
  );

  if (!gemRes.ok) {
    const msg = (await gemRes.json().catch(() => ({}))).error?.message ?? `Gemini ${gemRes.status}`;
    return res.status(502).json({ error: `AI 호출 실패: ${msg}` });
  }

  const data = await gemRes.json();
  const raw = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!raw) return res.status(502).json({ error: "AI 응답이 비어있습니다." });

  // DB 저장 안 함 — 요약 결과만 반환. 저장은 사용자가 미리보기 확인 후 POST /api/meetings.
  res.status(200).json(JSON.parse(raw));
}
