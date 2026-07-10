import { useEffect, useRef, useState } from "react";

const fmtDate = (d) =>
  new Date(d).toLocaleDateString("ko-KR", { year: "numeric", month: "short", day: "numeric" });

// 선택 가능한 Gemini 모델
const MODELS = [
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash — 빠르고 저렴 (권장)" },
  { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro — 고성능" },
  { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash" },
];

// ponytail: 키는 브라우저 localStorage에 보관(본인 키 사용 모델). 서버 DB에 저장 안 함.
// 팀 공유·다중 사용자로 가면 서버 측 암호화 저장으로 전환.
const loadSettings = () => ({
  apiKey: localStorage.getItem("gemini_api_key") ?? "",
  model: localStorage.getItem("gemini_model") ?? MODELS[0].id,
  // 요약 제공자: "gemini" | "local"(OpenAI 호환 로컬 서버)
  summaryProvider: localStorage.getItem("summary_provider") ?? "gemini",
  localBaseUrl: localStorage.getItem("local_base_url") ?? "http://localhost:11434/v1",
  localModel: localStorage.getItem("local_model") ?? "",
  // 음성 전사 전용 (선택). 비우면 위 Gemini 키/모델을 그대로 사용. (전사는 항상 Gemini)
  sttApiKey: localStorage.getItem("gemini_stt_api_key") ?? "",
  sttModel: localStorage.getItem("gemini_stt_model") ?? "",
});

async function api(path, opts) {
  const token = localStorage.getItem("auth_token");
  const res = await fetch(path, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...(token && { Authorization: `Bearer ${token}` }),
    },
  });
  if (res.status === 401 && path !== "/api/auth") {
    // 토큰 만료/무효 → 로그인 화면으로 (reload 시 토큰 없어 Login 표시)
    localStorage.removeItem("auth_token");
    location.reload();
    return new Promise(() => {}); // reload 전 후속 코드 실행 방지
  }
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
  return res.json();
}

// 큰 오디오는 브라우저 → Gemini Files API 직접 업로드(우리 서버리스 함수의 4.5MB 한도 우회).
const MAX_AUDIO_BYTES = 100 * 1024 * 1024; // Gemini 파일 상한은 훨씬 크지만 회의 녹음엔 충분

const AUDIO_MIME = {
  aac: "audio/aac", m4a: "audio/aac", mp3: "audio/mp3",
  wav: "audio/wav", ogg: "audio/ogg", flac: "audio/flac", aiff: "audio/aiff",
};
const mimeFor = (file) =>
  AUDIO_MIME[file.name.split(".").pop().toLowerCase()] ?? file.type ?? "audio/aac";

const geminiErr = async (res) =>
  (await res.json().catch(() => ({}))).error?.message ?? `Gemini ${res.status}`;

// 재개형(resumable) 업로드: start(세션 생성) → 바이트 업로드+finalize → ACTIVE 될 때까지 폴링.
async function uploadAudioToGemini(file, apiKey, onStage) {
  const mimeType = mimeFor(file);
  const base = "https://generativelanguage.googleapis.com";

  onStage?.("업로드 준비 중…");
  const start = await fetch(`${base}/upload/v1beta/files`, {
    method: "POST",
    headers: {
      "x-goog-api-key": apiKey,
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(file.size),
      "X-Goog-Upload-Header-Content-Type": mimeType,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ file: { display_name: file.name } }),
  });
  if (!start.ok) throw new Error(await geminiErr(start));
  const uploadUrl = start.headers.get("x-goog-upload-url");
  if (!uploadUrl) throw new Error("업로드 URL을 받지 못했습니다.");

  onStage?.("업로드 중…");
  const up = await fetch(uploadUrl, {
    method: "POST",
    // Content-Length는 브라우저가 File 크기로 자동 설정 (수동 지정은 무시됨)
    headers: { "X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize" },
    body: file,
  });
  if (!up.ok) throw new Error(await geminiErr(up));
  let meta = (await up.json()).file;

  // 오디오/영상은 업로드 후 서버 처리(PROCESSING → ACTIVE) 필요
  for (let i = 0; meta.state === "PROCESSING" && i < 60; i++) {
    onStage?.("오디오 처리 중…");
    await new Promise((r) => setTimeout(r, 1500));
    const poll = await fetch(`${base}/v1beta/${meta.name}`, { headers: { "x-goog-api-key": apiKey } });
    if (!poll.ok) throw new Error(await geminiErr(poll));
    meta = await poll.json();
  }
  if (meta.state !== "ACTIVE") throw new Error(`오디오 처리 실패 (${meta.state})`);
  return { fileUri: meta.uri, mimeType };
}

const TRANSCRIBE_PROMPT = `이 오디오는 회의 녹음이다. 요약·생략 없이 들리는 그대로 정확히 전사해라.
- 한국어로 말한 부분은 한국어 그대로 전사한다.
- 영어로 말한 부분은 영어 원문을 그대로 전사한 뒤, 바로 다음 줄에 자연스러운 한국어 번역을 함께 제공한다. 형식:
EN: <영어 원문>
KO: <한국어 번역>
화자가 구분되면 '화자1:', '화자2:'처럼 표기해라.`;

// 분할 전사 시 이어지는 조각용: 직전 조각 끝부분을 참고로 넘겨 문맥·화자 라벨 연속성 유지
const contPrompt = (prevTail) =>
  `${TRANSCRIBE_PROMPT}\n\n(참고) 이 오디오는 긴 녹음의 이어지는 조각이다. 직전 조각의 마지막 부분: "…${prevTail}"\n위 내용은 다시 쓰지 말고, 이 조각의 내용만 이어서 전사해라. 화자 번호는 직전 조각과 일관되게 붙여라.`;

/* ── 오디오 분할: 브라우저에서 디코딩 → 16kHz 모노 → N분 WAV 조각 ──
   긴 파일은 조각마다 전사해 결과가 점진적으로 도착(준실시간 체감).      */
const CHUNK_SEC = 300; // 5분
const SPLIT_RATE = 16000; // 음성 전사에 충분, 파일 크기 최소화

function encodeWav(samples, sampleRate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
  str(0, "RIFF"); v.setUint32(4, 36 + samples.length * 2, true); str(8, "WAVE");
  str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, "data"); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}

// 짧은 파일이면 null 반환(통짜 경로 사용 — 원본 그대로 보내 품질 손실 없음)
async function splitAudioToWavChunks(file) {
  const raw = await file.arrayBuffer();
  const probe = new AudioContext();
  let decoded;
  try {
    decoded = await probe.decodeAudioData(raw);
  } finally {
    probe.close();
  }
  if (decoded.duration <= CHUNK_SEC * 1.5) return null;

  // 모노 16kHz로 리샘플 (OfflineAudioContext)
  const frames = Math.ceil(decoded.duration * SPLIT_RATE);
  const off = new OfflineAudioContext(1, frames, SPLIT_RATE);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const mono = (await off.startRendering()).getChannelData(0);

  const per = CHUNK_SEC * SPLIT_RATE;
  const chunks = [];
  for (let i = 0; i < mono.length; i += per) {
    chunks.push(
      new File([encodeWav(mono.subarray(i, i + per), SPLIT_RATE)], `chunk-${chunks.length + 1}.wav`, {
        type: "audio/wav",
      }),
    );
  }
  return chunks;
}

// 전사도 브라우저에서 직접 Gemini 호출. 스트리밍(SSE)으로 받아 조각마다 onDelta 콜백.
async function transcribeWithGemini(fileUri, mimeType, apiKey, model, onDelta, prompt = TRANSCRIBE_PROMPT) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }, { fileData: { mimeType, fileUri } }] }],
      }),
    },
  );
  if (!res.ok) throw new Error("전사 실패: " + (await geminiErr(res)));

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";
  let finishReason = "";
  let note = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }); // stream:true → 한글 멀티바이트가 청크 경계서 안 깨지게
    // SSE를 줄 단위로 파싱 (\n·\r\n·\r 모두 대응). 각 이벤트는 한 줄 "data: {json}".
    const lines = buffer.split(/\r\n|\r|\n/);
    buffer = lines.pop() ?? ""; // 마지막 미완성 줄 보존
    for (const line of lines) {
      const l = line.trimStart();
      if (!l.startsWith("data:")) continue;
      const json = l.slice(5).trim();
      if (!json || json === "[DONE]") continue;
      let obj;
      try {
        obj = JSON.parse(json);
      } catch {
        continue;
      }
      if (obj.error?.message) note = obj.error.message;
      if (obj.promptFeedback?.blockReason) note = "차단됨: " + obj.promptFeedback.blockReason;
      const cand = obj.candidates?.[0];
      if (cand?.finishReason) finishReason = cand.finishReason;
      const delta = cand?.content?.parts?.map((p) => p.text).filter(Boolean).join("") ?? "";
      if (delta) {
        full += delta;
        onDelta?.(delta);
      }
    }
  }
  if (!full.trim()) {
    const why = note || (finishReason ? `finishReason=${finishReason}` : "모델이 텍스트를 반환하지 않음");
    throw new Error(
      `전사 결과가 비어있습니다 (${why}). 오디오에 사람 음성이 들리는지, 형식(aac/m4a/mp3/wav)이 맞는지 확인하세요.`,
    );
  }
  return full;
}

// 전사 완료 후 제목 자동 추천 (짧은 단발 호출 — 실패해도 전사 결과엔 영향 없음)
async function suggestTitle(text, apiKey, model) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: `다음 회의 전사문에 어울리는 간결한 회의 제목을 하나만 출력해라. 15자 내외, 따옴표·마침표·설명 없이 제목 텍스트만.\n\n${text}`,
              },
            ],
          },
        ],
      }),
    },
  );
  if (!res.ok) throw new Error(await geminiErr(res));
  const t = (await res.json()).candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!t) throw new Error("빈 제목");
  return t.split("\n")[0].replace(/^["'「『]+|["'」』.]+$/g, "").slice(0, 100);
}

// ── 요약: Gemini 또는 로컬 OpenAI 호환 서버 ─────────────────────
const SUMMARY_SYSTEM = `너는 회의록 정리 전문가다. 사용자가 준 회의 스크립트를 분석해서 JSON으로 정리한다.
규칙:
- summary: 회의 전체를 정확히 3문장으로 요약 (한 문장 = 배열 원소 하나)
- agenda: 주요 아젠다별로 topic(짧은 제목)과 discussion(논의 내용 2~3문장 요약)
- action_items: 후속 업무. assignee는 원문에 언급된 담당자만, 없으면 null. due_date는 원문의 기한 표현 그대로("7월 15일", "다음 주" 등), 없으면 null.
- tags: 회의 주제를 나타내는 태그 2~5개 (한국어, 짧게)
- 원문에 없는 내용을 지어내지 않는다.`;

// Gemini structured output 스키마 (OpenAPI 서브셋, 타입 대문자)
const SUMMARY_GEMINI_SCHEMA = {
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

// 로컬 LLM은 스키마 강제가 제각각이라 프롬프트로 형식을 못박는다.
const SUMMARY_JSON_HINT = `반드시 아래 JSON만 출력하라(코드펜스·설명 금지):
{"summary":["문장1","문장2","문장3"],"agenda":[{"topic":"...","discussion":"..."}],"action_items":[{"task":"...","assignee":null,"due_date":null}],"tags":["..."]}`;

const stripFences = (s) =>
  s.replace(/^\s*```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();

async function summarizeWithGemini(text, apiKey, model) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SUMMARY_SYSTEM }] },
        contents: [{ parts: [{ text }] }],
        generationConfig: { responseMimeType: "application/json", responseSchema: SUMMARY_GEMINI_SCHEMA },
      }),
    },
  );
  if (!res.ok) throw new Error("요약 실패: " + (await geminiErr(res)));
  const raw = (await res.json()).candidates?.[0]?.content?.parts?.[0]?.text;
  if (!raw) throw new Error("요약 응답이 비어있습니다.");
  return JSON.parse(raw);
}

async function summarizeWithLocal(text, baseUrl, model) {
  const url = baseUrl.replace(/\/+$/, "") + "/chat/completions";
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SUMMARY_SYSTEM + "\n\n" + SUMMARY_JSON_HINT },
          { role: "user", content: text },
        ],
      }),
    });
  } catch (e) {
    throw new Error(
      `로컬 서버에 연결할 수 없습니다 (${url}). 서버 실행 여부·주소·CORS 허용을 확인하세요. ${e.message}`,
    );
  }
  if (!res.ok)
    throw new Error(`로컬 요약 실패: ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const content = (await res.json()).choices?.[0]?.message?.content ?? "";
  try {
    return JSON.parse(stripFences(content));
  } catch {
    throw new Error("로컬 모델이 올바른 JSON을 반환하지 않았습니다. 더 큰 모델을 쓰거나 다시 시도하세요.");
  }
}

// 제공자 분기
async function summarizeText(text, settings) {
  if (settings.summaryProvider === "local") {
    if (!settings.localBaseUrl?.trim()) throw new Error("로컬 서버 주소를 설정에서 입력해주세요.");
    if (!settings.localModel?.trim()) throw new Error("로컬 모델명을 설정에서 입력해주세요.");
    return summarizeWithLocal(text, settings.localBaseUrl, settings.localModel);
  }
  if (!settings.apiKey) throw new Error("Gemini API 키를 설정에서 입력해주세요.");
  return summarizeWithGemini(text, settings.apiKey, settings.model);
}

function Tag({ children }) {
  return (
    <span className="rounded-full bg-teal-50 px-2.5 py-0.5 text-xs font-medium text-teal-700">
      {children}
    </span>
  );
}

/* ── 로그인 / 회원가입 ───────────────────────────────────── */
function Login({ onLogin }) {
  const [mode, setMode] = useState("login"); // "login" | "signup"
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  // 봇 방지: 가입 모드 진입 시 서버 챌린지 발급(최소 3초 뒤 제출 가능) + 허니팟 필드
  const [challenge, setChallenge] = useState(null);
  const [website, setWebsite] = useState(""); // 허니팟 — 사람은 볼 수 없음, 채워지면 봇

  useEffect(() => {
    if (mode === "signup") api("/api/auth").then((d) => setChallenge(d.challenge)).catch(() => {});
  }, [mode]);

  const submit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const { token, email: savedEmail } = await api("/api/auth", {
        method: "POST",
        body: JSON.stringify({ action: mode, email, password, challenge, website }),
      });
      localStorage.setItem("auth_token", token);
      localStorage.setItem("auth_email", savedEmail);
      onLogin();
    } catch (err) {
      setError(err.message);
      setLoading(false);
    }
  };

  const isSignup = mode === "signup";

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
        <div className="flex items-center gap-2">
          <span className="text-2xl">📝</span>
          <h1 className="text-lg font-bold text-slate-800">Meeting Minutes</h1>
        </div>
        <p className="mt-2 text-sm text-slate-500">
          {isSignup ? "새 계정을 만드세요." : "이메일과 비밀번호로 로그인하세요."}
        </p>

        <label className="mt-5 block text-sm font-medium text-slate-700">이메일</label>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          autoFocus
          autoComplete="email"
          className="mt-1.5 w-full rounded-xl border border-slate-200 px-4 py-2.5 text-sm outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
        />

        <label className="mt-4 block text-sm font-medium text-slate-700">비밀번호</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={isSignup ? "8자 이상" : "비밀번호"}
          autoComplete={isSignup ? "new-password" : "current-password"}
          className="mt-1.5 w-full rounded-xl border border-slate-200 px-4 py-2.5 text-sm outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
        />

        {/* 허니팟 (봇 방지) — 화면에 보이지 않는 필드. 자동 프로그램이 채우면 가입 거부 */}
        <input
          type="text"
          name="website"
          value={website}
          onChange={(e) => setWebsite(e.target.value)}
          className="hidden"
          tabIndex={-1}
          autoComplete="off"
          aria-hidden="true"
        />

        {error && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">⚠️ {error}</p>}

        <button
          type="submit"
          disabled={loading || !email || password.length < 8}
          className="mt-5 w-full rounded-xl bg-teal-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-teal-600 disabled:opacity-40"
        >
          {loading ? "확인 중…" : isSignup ? "회원가입" : "로그인"}
        </button>

        <button
          type="button"
          onClick={() => { setMode(isSignup ? "login" : "signup"); setError(null); }}
          className="mt-4 w-full text-center text-sm text-teal-700 hover:underline"
        >
          {isSignup ? "이미 계정이 있으신가요? 로그인" : "계정이 없으신가요? 회원가입"}
        </button>
      </form>
    </div>
  );
}

/* ── 설정: 요약 제공자(Gemini/로컬) + 전사(Gemini) ─────────── */
const INPUT_CLS =
  "mt-1.5 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-100";

function Settings({ settings, onSave, onClose }) {
  const [apiKey, setApiKey] = useState(settings.apiKey);
  const [model, setModel] = useState(settings.model);
  const [summaryProvider, setSummaryProvider] = useState(settings.summaryProvider);
  const [localBaseUrl, setLocalBaseUrl] = useState(settings.localBaseUrl);
  const [localModel, setLocalModel] = useState(settings.localModel);
  const [sttApiKey, setSttApiKey] = useState(settings.sttApiKey);
  const [sttModel, setSttModel] = useState(settings.sttModel);

  const save = () => {
    const next = {
      apiKey: apiKey.trim(),
      model,
      summaryProvider,
      localBaseUrl: localBaseUrl.trim(),
      localModel: localModel.trim(),
      sttApiKey: sttApiKey.trim(),
      sttModel,
    };
    localStorage.setItem("gemini_api_key", next.apiKey);
    localStorage.setItem("gemini_model", next.model);
    localStorage.setItem("summary_provider", next.summaryProvider);
    localStorage.setItem("local_base_url", next.localBaseUrl);
    localStorage.setItem("local_model", next.localModel);
    localStorage.setItem("gemini_stt_api_key", next.sttApiKey);
    localStorage.setItem("gemini_stt_model", next.sttModel);
    onSave(next);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center bg-slate-900/40 p-4" onClick={onClose}>
      <div
        className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-bold text-slate-800">설정</h2>
        <p className="mt-1 text-xs text-slate-500">
          모든 값은 이 브라우저에만 저장되며 서버에 보관되지 않습니다.
        </p>

        {/* Gemini 키 (전사에 필수, 요약 제공자가 Gemini면 요약에도 사용) */}
        <label className="mt-5 block text-sm font-medium text-slate-700">Gemini API 키</label>
        <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)}
          placeholder="AIza..." className={INPUT_CLS} />
        <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer"
          className="mt-1 inline-block text-xs text-teal-700 hover:underline">
          → Google AI Studio에서 키 발급
        </a>
        <p className="mt-1 text-xs text-slate-400">오디오 전사는 항상 Gemini를 사용하므로 이 키가 필요합니다.</p>

        {/* 요약 제공자 */}
        <div className="mt-6 border-t border-slate-100 pt-5">
          <h3 className="text-sm font-semibold text-slate-700">요약 제공자</h3>
          <div className="mt-2 flex gap-2">
            {[["gemini", "Gemini (클라우드)"], ["local", "로컬 LLM"]].map(([v, label]) => (
              <button key={v} onClick={() => setSummaryProvider(v)}
                className={`flex-1 rounded-xl border px-3 py-2 text-sm font-medium ${
                  summaryProvider === v ? "border-teal-500 bg-teal-50 text-teal-700" : "border-slate-200 text-slate-500"
                }`}>
                {label}
              </button>
            ))}
          </div>

          {summaryProvider === "gemini" ? (
            <>
              <label className="mt-4 block text-sm font-medium text-slate-700">Gemini 요약 모델</label>
              <select value={model} onChange={(e) => setModel(e.target.value)} className={INPUT_CLS + " bg-white"}>
                {MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
            </>
          ) : (
            <>
              <label className="mt-4 block text-sm font-medium text-slate-700">로컬 서버 주소 (OpenAI 호환)</label>
              <input value={localBaseUrl} onChange={(e) => setLocalBaseUrl(e.target.value)}
                placeholder="http://localhost:11434/v1" className={INPUT_CLS} />
              <label className="mt-4 block text-sm font-medium text-slate-700">로컬 모델명</label>
              <input value={localModel} onChange={(e) => setLocalModel(e.target.value)}
                placeholder="예: llama3.1, qwen2.5" className={INPUT_CLS} />
              <p className="mt-1 text-xs text-slate-400">
                Ollama·LM Studio 등. 브라우저와 같은 PC에서 실행 중이어야 하고, 서버에 CORS 허용이 필요합니다.
              </p>
            </>
          )}
        </div>

        {/* 음성 전사 전용 (선택) — 전사는 항상 Gemini */}
        <div className="mt-6 border-t border-slate-100 pt-5">
          <h3 className="text-sm font-semibold text-slate-700">음성 전사 전용 (선택)</h3>
          <p className="mt-1 text-xs text-slate-500">
            전사는 항상 Gemini입니다. 다른 키/모델을 쓰려면 입력하세요. 비우면 위 Gemini 키/모델을 사용합니다.
          </p>

          <label className="mt-4 block text-sm font-medium text-slate-700">전사용 API 키</label>
          <input type="password" value={sttApiKey} onChange={(e) => setSttApiKey(e.target.value)}
            placeholder="비워두면 위 Gemini 키 사용" className={INPUT_CLS} />

          <label className="mt-4 block text-sm font-medium text-slate-700">전사용 모델</label>
          <input list="stt-models" value={sttModel} onChange={(e) => setSttModel(e.target.value.trim())}
            placeholder="비워두면 위 Gemini 요약 모델과 동일" className={INPUT_CLS} />
          <datalist id="stt-models">
            {MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </datalist>
          <p className="mt-1 text-xs text-slate-500">
            목록에서 고르거나 다른 Gemini 모델 ID를 직접 입력할 수 있습니다 (예: gemini-2.5-flash-lite).
          </p>
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-xl px-4 py-2 text-sm font-medium text-slate-500 hover:bg-slate-100">
            취소
          </button>
          <button onClick={save} className="rounded-xl bg-teal-700 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-600">
            저장
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── 전사 진행 패널: 새 회의록·목록 어디서든 진행 상황 표시 ── */
function TransPanel({ trans, onGoto, onDismiss }) {
  const liveRef = useRef(null);
  useEffect(() => {
    const el = liveRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [trans.liveText]);

  if (trans.status === "idle") return null;
  return (
    <div className="rounded-xl border border-teal-200 bg-teal-50/40 p-4">
      <div className="flex flex-wrap items-center gap-2 text-xs font-semibold">
        {trans.status === "running" && (
          <>
            <span className="inline-block size-2 animate-pulse rounded-full bg-teal-500" />
            <span className="text-teal-700">🎙️ {trans.fileName} — {trans.stage || "전사 중…"}</span>
          </>
        )}
        {trans.status === "done" && (
          <span className="text-teal-700">✅ {trans.fileName} 전사 완료 — 새 회의록 입력란에 채워졌습니다.</span>
        )}
        {trans.status === "error" && <span className="text-red-600">⚠️ 전사 실패: {trans.error}</span>}
        <span className="ml-auto flex items-center gap-3">
          {onGoto && (
            <button onClick={onGoto} className="font-medium text-teal-700 hover:underline">
              새 회의록으로 →
            </button>
          )}
          {trans.status !== "running" && onDismiss && (
            <button onClick={onDismiss} title="닫기" className="text-slate-400 hover:text-slate-600">✕</button>
          )}
        </span>
      </div>
      {trans.status === "running" && trans.liveText && (
        <pre
          ref={liveRef}
          className="mt-2 max-h-52 overflow-y-auto whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-700"
        >
          {trans.liveText}
        </pre>
      )}
    </div>
  );
}

/* ── 대시보드: 회의록 리스트 + 검색(키워드·날짜 범위) ─────── */
function Dashboard({ onOpen, onNew, trans, onGotoNew, onDismissTrans }) {
  const [meetings, setMeetings] = useState(null);
  const [q, setQ] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  useEffect(() => {
    const t = setTimeout(
      () =>
        api(`/api/meetings?q=${encodeURIComponent(q)}&from=${from}&to=${to}`)
          .then(setMeetings)
          .catch(console.error),
      q ? 300 : 0,
    );
    return () => clearTimeout(t);
  }, [q, from, to]);

  const hasFilter = q || from || to;

  return (
    <div className="space-y-6">
      {/* 백그라운드 전사 진행 카드 — 목록에 있어도 진행 상황이 보임 */}
      <TransPanel trans={trans} onGoto={onGotoNew} onDismiss={onDismissTrans} />

      <div className="flex flex-wrap items-center gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="제목, 내용, 태그로 검색…"
          className="min-w-40 flex-1 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm shadow-sm outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
        />
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} title="시작일"
          className="rounded-xl border border-slate-200 bg-white px-2.5 py-2 text-sm text-slate-600 shadow-sm outline-none focus:border-teal-500" />
        <span className="text-slate-400">~</span>
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} title="종료일"
          className="rounded-xl border border-slate-200 bg-white px-2.5 py-2 text-sm text-slate-600 shadow-sm outline-none focus:border-teal-500" />
        <button
          onClick={onNew}
          className="rounded-xl bg-teal-700 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-teal-600"
        >
          + 새 회의록
        </button>
      </div>

      {meetings === null ? (
        <p className="py-16 text-center text-sm text-slate-400">불러오는 중…</p>
      ) : meetings.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-300 py-16 text-center">
          <p className="text-slate-500">{hasFilter ? "검색 결과가 없습니다." : "아직 회의록이 없습니다."}</p>
          {!hasFilter && (
            <button onClick={onNew} className="mt-3 text-sm font-medium text-teal-700 hover:underline">
              첫 회의록 작성하기 →
            </button>
          )}
        </div>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {meetings.map((m) => (
            <li key={m.id}>
              <button
                onClick={() => onOpen(m.id)}
                className="w-full rounded-2xl border border-slate-200 bg-white p-5 text-left shadow-sm transition hover:border-teal-400 hover:shadow-md"
              >
                <div className="flex items-start justify-between gap-2">
                  <h3 className="font-semibold text-slate-800">{m.title}</h3>
                  <time className="shrink-0 text-xs text-slate-400">{fmtDate(m.created_at)}</time>
                </div>
                <p className="mt-2 line-clamp-2 text-sm text-slate-500">{m.summary?.[0]}</p>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {m.visibility === "workspace" && (
                    <span className="rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-700">
                      👥 공개{!m.is_owner && m.owner_email ? ` · ${m.owner_email}` : ""}
                    </span>
                  )}
                  {m.tags?.map((t) => <Tag key={t}>{t}</Tag>)}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ── 액션 아이템: 전체 목록 + 검색(키워드·날짜 범위) ───────── */
function ActionItems({ onOpenMeeting }) {
  const [items, setItems] = useState(null);
  const [q, setQ] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  useEffect(() => {
    const t = setTimeout(
      () =>
        api(`/api/action-items?q=${encodeURIComponent(q)}&from=${from}&to=${to}`)
          .then(setItems)
          .catch(console.error),
      q ? 300 : 0,
    );
    return () => clearTimeout(t);
  }, [q, from, to]);

  const toggle = async (item) => {
    setItems((p) => p.map((a) => (a.id === item.id ? { ...a, done: !a.done } : a)));
    await api(`/api/meetings/${item.meeting_id}`, {
      method: "PATCH",
      body: JSON.stringify({ actionItemId: item.id, done: !item.done }),
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="할 일, 담당자, 회의 제목으로 검색…"
          className="min-w-40 flex-1 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm shadow-sm outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
        />
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} title="시작일"
          className="rounded-xl border border-slate-200 bg-white px-2.5 py-2 text-sm text-slate-600 shadow-sm outline-none focus:border-teal-500" />
        <span className="text-slate-400">~</span>
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} title="종료일"
          className="rounded-xl border border-slate-200 bg-white px-2.5 py-2 text-sm text-slate-600 shadow-sm outline-none focus:border-teal-500" />
      </div>

      {items === null ? (
        <p className="py-16 text-center text-sm text-slate-400">불러오는 중…</p>
      ) : items.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-300 py-16 text-center">
          <p className="text-slate-500">
            {q || from || to ? "검색 결과가 없습니다." : "액션 아이템이 없습니다."}
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {items.map((a) => (
            <li key={a.id} className="rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
              <label className="flex cursor-pointer items-start gap-3">
                <input type="checkbox" checked={a.done} onChange={() => toggle(a)}
                  className="mt-0.5 size-4 accent-teal-700" />
                <div className="min-w-0 flex-1">
                  <p className={`text-sm ${a.done ? "text-slate-400 line-through" : "text-slate-700"}`}>
                    {a.task}
                  </p>
                  <p className="mt-0.5 text-xs text-slate-400">
                    {a.assignee && <span className="mr-3">👤 {a.assignee}</span>}
                    {a.due_date && <span>📅 {a.due_date}</span>}
                  </p>
                </div>
              </label>
              <button
                onClick={() => onOpenMeeting(a.meeting_id)}
                className="ml-7 mt-1 text-xs text-teal-700 hover:underline"
              >
                📝 {a.meeting_title} · {fmtDate(a.meeting_date)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ── 새 회의록: 텍스트 입력 + 오디오 전사 (전사 상태는 App이 보유 → 화면 이동해도 계속) ── */
function NewMeeting({ settings, draft, setDraft, trans, onTranscribe, onDismissTrans, onDone, onCancel, onOpenSettings }) {
  const { title, text } = draft;
  const setTitle = (v) => setDraft((p) => ({ ...p, title: v }));
  const setText = (v) => setDraft((p) => ({ ...p, text: v }));
  const [audioFile, setAudioFile] = useState(null);
  const [visibility, setVisibility] = useState("private");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState(null); // AI 요약 결과 (아직 미저장)
  const [error, setError] = useState(null);

  // 1단계: 요약 (브라우저에서 Gemini 또는 로컬 LLM 호출, DB 저장 안 함)
  const summarize = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await summarizeText(text, settings);
      setPreview(result);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  // 2단계: 미리보기 확인 후 저장 (공개 범위 포함)
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const meeting = await api("/api/meetings", {
        method: "POST",
        body: JSON.stringify({ title, text, visibility, ...preview }),
      });
      onDone(meeting.id);
    } catch (e) {
      setError(e.message);
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      <button onClick={onCancel} className="text-sm font-medium text-teal-700 hover:underline">
        ← 목록으로
      </button>

      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="회의 제목"
        className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-lg font-semibold shadow-sm outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
      />

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={14}
        placeholder={"회의 스크립트를 붙여넣으세요.\n\n예)\n김PM: 이번 스프린트 목표부터 정리하겠습니다…\n이대리: 디자인 시안은 금요일까지 전달드릴게요…"}
        className="w-full resize-y rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm leading-relaxed shadow-sm outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
      />

      {/* 오디오 업로드 → Gemini 전사 → 위 입력란에 텍스트 채움 (목록으로 이동해도 계속 진행) */}
      <div className="flex items-center gap-3 rounded-xl border border-dashed border-slate-300 px-4 py-3">
        <label className="flex flex-1 cursor-pointer items-center gap-2 text-sm text-slate-500">
          {/* 일부 브라우저는 audio/* 만으로 .aac를 안 걸러줘서 확장자를 명시 */}
          <input type="file" accept="audio/*,.aac,.m4a,.mp3,.wav" className="hidden"
            onChange={(e) => setAudioFile(e.target.files?.[0] ?? null)} />
          <span>🎙️ {audioFile?.name ?? "오디오 파일 선택 (aac, m4a, mp3, wav · 최대 100MB)"}</span>
        </label>
        {audioFile && (
          <button
            onClick={() => onTranscribe(audioFile)}
            disabled={trans.status === "running"}
            className="shrink-0 rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-700 disabled:opacity-40"
          >
            {trans.status === "running" ? "변환 중…" : "🔤 텍스트로 변환"}
          </button>
        )}
      </div>

      {/* 전사 실시간 진행창 */}
      <TransPanel trans={trans} onDismiss={onDismissTrans} />

      <div className="flex items-center justify-between rounded-xl bg-slate-100 px-4 py-2.5 text-xs text-slate-500">
        <span>
          {settings.summaryProvider === "local"
            ? `요약: 로컬 ${settings.localModel || "(모델 미설정)"} @ ${settings.localBaseUrl || "(주소 미설정)"}`
            : settings.apiKey
              ? `요약: Gemini ${MODELS.find((m) => m.id === settings.model)?.label ?? settings.model}`
              : "⚠️ Gemini API 키가 설정되지 않았습니다."}
        </span>
        <button onClick={onOpenSettings} className="font-medium text-teal-700 hover:underline">
          설정 변경
        </button>
      </div>

      {error && <p className="rounded-lg bg-red-50 px-4 py-2 text-sm text-red-600">⚠️ {error}</p>}

      {!preview ? (
        <div className="flex justify-end gap-3">
          <button onClick={onCancel} className="rounded-xl px-4 py-2.5 text-sm font-medium text-slate-500 hover:bg-slate-100">
            취소
          </button>
          <button
            onClick={summarize}
            disabled={loading || !title.trim() || !text.trim()}
            className="rounded-xl bg-teal-700 px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-teal-600 disabled:opacity-40"
          >
            {loading ? "AI 분석 중… (10~20초)" : "AI 요약 생성"}
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          <SummaryPreview data={preview} />

          {/* 공개 범위: 나만 보기 vs 가입자 전체 공개 */}
          <div className="flex items-center justify-between rounded-xl bg-slate-100 px-4 py-2.5">
            <label className="text-sm text-slate-600">공개 범위</label>
            <select
              value={visibility}
              onChange={(e) => setVisibility(e.target.value)}
              className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-teal-500"
            >
              <option value="private">🔒 나만 보기</option>
              <option value="workspace">👥 전체 공개 (가입한 모든 사용자)</option>
            </select>
          </div>

          <div className="flex justify-end gap-3">
            <button
              onClick={() => setPreview(null)}
              disabled={saving}
              className="rounded-xl px-4 py-2.5 text-sm font-medium text-slate-500 hover:bg-slate-100 disabled:opacity-40"
            >
              다시 요약
            </button>
            <button
              onClick={save}
              disabled={saving}
              className="rounded-xl bg-teal-700 px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-teal-600 disabled:opacity-40"
            >
              {saving ? "저장 중…" : "이대로 저장"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── 요약 미리보기 (저장 전, 읽기 전용) ─────────────────────── */
function SummaryPreview({ data }) {
  return (
    <div className="space-y-4 rounded-2xl border border-teal-200 bg-teal-50/40 p-5">
      <div className="flex items-center gap-2">
        <span className="rounded-full bg-teal-700 px-2.5 py-0.5 text-xs font-semibold text-white">미리보기</span>
        <span className="text-xs text-slate-500">저장하기 전 결과입니다.</span>
      </div>

      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-400">3줄 요약</h4>
        <ol className="mt-2 space-y-1.5">
          {data.summary.map((s, i) => (
            <li key={i} className="flex gap-2 text-sm text-slate-700">
              <span className="font-bold text-teal-700">{i + 1}</span>{s}
            </li>
          ))}
        </ol>
      </div>

      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-400">주요 아젠다</h4>
        <div className="mt-2 space-y-2.5">
          {data.agenda.map((a, i) => (
            <div key={i} className="border-l-2 border-teal-300 pl-3">
              <p className="text-sm font-semibold text-slate-800">{a.topic}</p>
              <p className="mt-0.5 text-sm text-slate-600">{a.discussion}</p>
            </div>
          ))}
        </div>
      </div>

      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
          액션 아이템 ({data.action_items.length})
        </h4>
        <ul className="mt-2 space-y-1.5">
          {data.action_items.length === 0 && <li className="text-sm text-slate-400">없음</li>}
          {data.action_items.map((a, i) => (
            <li key={i} className="text-sm text-slate-700">
              • {a.task}
              <span className="ml-2 text-xs text-slate-400">
                {a.assignee && <span className="mr-2">👤 {a.assignee}</span>}
                {a.due_date && <span>📅 {a.due_date}</span>}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {data.tags.map((t) => <Tag key={t}>{t}</Tag>)}
      </div>
    </div>
  );
}

/* ── 회의록 상세: 요약 / 아젠다 / 액션 아이템 ─────────────── */
function Detail({ id, onBack }) {
  const [m, setM] = useState(null);
  const [showRaw, setShowRaw] = useState(false);

  useEffect(() => {
    api(`/api/meetings/${id}`).then(setM).catch(console.error);
  }, [id]);

  const toggle = async (item) => {
    if (!m.is_owner) return; // 공개 회의록 열람자는 토글 불가 (서버에서도 차단)
    setM((p) => ({
      ...p,
      action_items: p.action_items.map((a) => (a.id === item.id ? { ...a, done: !a.done } : a)),
    }));
    await api(`/api/meetings/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ actionItemId: item.id, done: !item.done }),
    });
  };

  if (!m) return <p className="py-16 text-center text-sm text-slate-400">불러오는 중…</p>;

  return (
    <div className="space-y-6">
      <button onClick={onBack} className="text-sm font-medium text-teal-700 hover:underline">
        ← 목록으로
      </button>

      <div>
        <h2 className="text-2xl font-bold text-slate-800">{m.title}</h2>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <time className="text-sm text-slate-400">{fmtDate(m.created_at)}</time>
          {m.visibility === "workspace" && (
            <span className="rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-700">
              👥 공개{!m.is_owner && m.owner_email ? ` · 작성자 ${m.owner_email}` : ""}
            </span>
          )}
          {m.tags?.map((t) => <Tag key={t}>{t}</Tag>)}
        </div>
      </div>

      <section className="rounded-2xl bg-slate-900 p-6 text-slate-100 shadow-sm">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-400">3줄 요약</h3>
        <ol className="mt-3 space-y-2">
          {m.summary.map((s, i) => (
            <li key={i} className="flex gap-3 text-sm leading-relaxed">
              <span className="font-bold text-slate-500">{i + 1}</span>{s}
            </li>
          ))}
        </ol>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-400">주요 아젠다</h3>
        <div className="mt-4 space-y-4">
          {m.agenda.map((a, i) => (
            <div key={i} className="border-l-2 border-teal-300 pl-4">
              <h4 className="font-semibold text-slate-800">{a.topic}</h4>
              <p className="mt-1 text-sm leading-relaxed text-slate-600">{a.discussion}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
          액션 아이템 ({m.action_items.filter((a) => a.done).length}/{m.action_items.length})
        </h3>
        <ul className="mt-4 space-y-2">
          {m.action_items.length === 0 && (
            <li className="text-sm text-slate-400">추출된 액션 아이템이 없습니다.</li>
          )}
          {m.action_items.map((a) => (
            <li key={a.id}>
              <label className={`flex items-start gap-3 rounded-xl px-3 py-2.5 ${m.is_owner ? "cursor-pointer hover:bg-slate-50" : ""}`}>
                <input type="checkbox" checked={a.done} onChange={() => toggle(a)} disabled={!m.is_owner}
                  className="mt-0.5 size-4 accent-teal-700 disabled:opacity-50" />
                <div className="min-w-0">
                  <p className={`text-sm ${a.done ? "text-slate-400 line-through" : "text-slate-700"}`}>
                    {a.task}
                  </p>
                  <p className="mt-0.5 text-xs text-slate-400">
                    {a.assignee && <span className="mr-3">👤 {a.assignee}</span>}
                    {a.due_date && <span>📅 {a.due_date}</span>}
                  </p>
                </div>
              </label>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <button onClick={() => setShowRaw(!showRaw)} className="text-sm font-medium text-slate-500 hover:text-slate-700">
          {showRaw ? "▾ 원문 접기" : "▸ 회의 원문 보기"}
        </button>
        {showRaw && (
          <pre className="mt-3 whitespace-pre-wrap rounded-2xl bg-slate-100 p-5 text-sm leading-relaxed text-slate-600">
            {m.raw_text}
          </pre>
        )}
      </section>
    </div>
  );
}

/* ── 앱 셸 ────────────────────────────────────────────────── */
const IDLE_TRANS = { status: "idle", stage: "", liveText: "", fileName: "", error: null };

export default function App() {
  // ponytail: 라우터 없이 view state로 화면 전환. URL 공유 필요해지면 react-router 도입.
  const [view, setView] = useState({ name: "list" });
  const [settings, setSettings] = useState(loadSettings);
  const [showSettings, setShowSettings] = useState(false);
  const [authed, setAuthed] = useState(() => !!localStorage.getItem("auth_token"));
  // 작성 중인 초안 + 전사 진행 상태를 App이 보유 → 화면을 이동해도 전사가 계속되고 목록에서도 보임
  const [draft, setDraft] = useState({ title: "", text: "" });
  const [trans, setTrans] = useState(IDLE_TRANS);

  // 오디오 → 텍스트 (백그라운드 실행: 어느 화면에 있든 진행)
  const startTranscription = async (audioFile) => {
    if (trans.status === "running") return;
    const sttKey = settings.sttApiKey || settings.apiKey;
    const sttModel = settings.sttModel || settings.model;
    const fail = (msg) =>
      setTrans({ status: "error", stage: "", liveText: "", fileName: audioFile.name, error: msg });
    if (!sttKey) return fail("먼저 설정에서 Gemini API 키를 입력해주세요.");
    if (!/^gemini-[a-z0-9.-]+$/.test(sttModel))
      return fail("전사용 모델 ID 형식이 올바르지 않습니다 (예: gemini-2.5-flash).");
    if (audioFile.size > MAX_AUDIO_BYTES)
      return fail("오디오가 너무 큽니다 (최대 100MB). 더 짧은 파일을 사용하거나 잘라서 올려주세요.");

    const setStage = (stage) => setTrans((p) => ({ ...p, stage }));
    const addDelta = (delta) => setTrans((p) => ({ ...p, liveText: p.liveText + delta }));
    setTrans({ status: "running", stage: "오디오 분석 중…", liveText: "", fileName: audioFile.name, error: null });
    try {
      // 긴 파일은 5분 조각으로 분할 → 조각마다 전사 결과가 도착 (준실시간 체감)
      let chunks = null;
      try {
        chunks = await splitAudioToWavChunks(audioFile);
      } catch {
        chunks = null; // 디코딩 실패(특이 코덱 등) → 통짜 전사로 폴백
      }

      let acc = "";
      if (chunks) {
        for (let i = 0; i < chunks.length; i++) {
          const label = `조각 ${i + 1}/${chunks.length}`;
          const { fileUri, mimeType } = await uploadAudioToGemini(chunks[i], sttKey, (s) =>
            setStage(`${label} · ${s}`),
          );
          setStage(`${label} · 전사 중…`);
          const prevTail = acc.slice(-200).trim();
          const t = await transcribeWithGemini(
            fileUri, mimeType, sttKey, sttModel, addDelta,
            prevTail ? contPrompt(prevTail) : TRANSCRIBE_PROMPT,
          );
          acc = acc ? acc.trimEnd() + "\n" + t.trim() : t.trim();
          setTrans((p) => ({ ...p, liveText: acc + "\n" }));
        }
      } else {
        // 짧은 파일(또는 분할 실패): 원본 그대로 통짜 전사
        const { fileUri, mimeType } = await uploadAudioToGemini(audioFile, sttKey, setStage);
        setStage("전사 중…");
        acc = await transcribeWithGemini(fileUri, mimeType, sttKey, sttModel, addDelta);
      }

      // 완료 → 초안 입력란에 채움 (사용자가 어느 화면에 있든)
      setDraft((prev) => ({
        ...prev,
        text: prev.text.trim() ? prev.text.trimEnd() + "\n\n" + acc : acc,
      }));

      // 제목 자동 추천 — 초안 제목이 비어있을 때만 적용 (실패해도 무시)
      try {
        setStage("제목 추천 중…");
        const suggested = await suggestTitle(acc.slice(0, 4000), sttKey, sttModel);
        setDraft((prev) => (prev.title.trim() ? prev : { ...prev, title: suggested }));
      } catch {
        /* 부가 기능 — 조용히 넘어감 */
      }

      setTrans({ status: "done", stage: "", liveText: "", fileName: audioFile.name, error: null });
    } catch (e) {
      fail(e.message);
    }
  };

  if (!authed) return <Login onLogin={() => setAuthed(true)} />;

  const logout = () => {
    localStorage.removeItem("auth_token");
    localStorage.removeItem("auth_email");
    setAuthed(false);
    setView({ name: "list" });
  };

  // 저장 완료 → 초안·전사 상태 초기화 후 상세로 이동
  const finishSave = (id) => {
    setDraft({ title: "", text: "" });
    setTrans(IDLE_TRANS);
    setView({ name: "detail", id });
  };

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-3xl items-center gap-2 px-4 py-4">
          <span className="text-xl">📝</span>
          <h1 className="font-bold text-slate-800">Meeting Minutes</h1>
          <span className="ml-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">AI 요약</span>
          <button
            onClick={() => setShowSettings(true)}
            title="설정"
            className="ml-auto rounded-lg px-2.5 py-1.5 text-sm text-slate-500 hover:bg-slate-100"
          >
            ⚙️ 설정
          </button>
          <span className="hidden text-xs text-slate-400 sm:inline">
            {localStorage.getItem("auth_email")}
          </span>
          <button
            onClick={logout}
            title="로그아웃"
            className="rounded-lg px-2.5 py-1.5 text-sm text-slate-500 hover:bg-slate-100"
          >
            로그아웃
          </button>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-8">
        {/* 탭: 회의록 / 액션 아이템 */}
        {(view.name === "list" || view.name === "actions") && (
          <div className="mb-6 flex gap-2">
            {[["list", "📝 회의록"], ["actions", "✅ 액션 아이템"]].map(([name, label]) => (
              <button
                key={name}
                onClick={() => setView({ name })}
                className={`rounded-xl px-4 py-2 text-sm font-semibold ${
                  view.name === name
                    ? "bg-teal-700 text-white shadow-sm"
                    : "bg-white text-slate-500 border border-slate-200 hover:bg-slate-50"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        )}

        {view.name === "list" && (
          <Dashboard
            onOpen={(id) => setView({ name: "detail", id })}
            onNew={() => setView({ name: "new" })}
            trans={trans}
            onGotoNew={() => setView({ name: "new" })}
            onDismissTrans={() => setTrans(IDLE_TRANS)}
          />
        )}
        {view.name === "actions" && (
          <ActionItems onOpenMeeting={(id) => setView({ name: "detail", id })} />
        )}
        {view.name === "new" && (
          <NewMeeting
            settings={settings}
            draft={draft}
            setDraft={setDraft}
            trans={trans}
            onTranscribe={startTranscription}
            onDismissTrans={() => setTrans(IDLE_TRANS)}
            onDone={finishSave}
            onCancel={() => setView({ name: "list" })}
            onOpenSettings={() => setShowSettings(true)}
          />
        )}
        {view.name === "detail" && <Detail id={view.id} onBack={() => setView({ name: "list" })} />}
      </main>

      {showSettings && (
        <Settings settings={settings} onSave={setSettings} onClose={() => setShowSettings(false)} />
      )}
    </div>
  );
}
