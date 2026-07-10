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
  // 음성 전사 전용 (선택). 비우면 위 요약용 키/모델을 그대로 사용.
  sttApiKey: localStorage.getItem("gemini_stt_api_key") ?? "",
  sttModel: localStorage.getItem("gemini_stt_model") ?? "",
});

async function api(path, opts) {
  const res = await fetch(path, opts && { headers: { "Content-Type": "application/json" }, ...opts });
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

const TRANSCRIBE_PROMPT =
  "이 오디오는 회의 녹음이다. 들리는 내용을 한국어로 정확히 전사해라. 요약하거나 생략하지 말고 말한 그대로 받아써라. 화자가 구분되면 '화자1:', '화자2:'처럼 표기해라.";

// 전사도 브라우저에서 직접 Gemini 호출. 스트리밍(SSE)으로 받아 조각마다 onDelta 콜백.
async function transcribeWithGemini(fileUri, mimeType, apiKey, model, onDelta) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text: TRANSCRIBE_PROMPT }, { fileData: { mimeType, fileUri } }] }],
      }),
    },
  );
  if (!res.ok) throw new Error("전사 실패: " + (await geminiErr(res)));

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }); // stream:true → 한글 멀티바이트가 청크 경계서 안 깨지게
    // SSE 이벤트는 빈 줄(\n\n)로 구분, 각 이벤트는 "data: {json}" 라인
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? ""; // 마지막 미완성 조각 보존
    for (const ev of events) {
      const line = ev.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      const json = line.slice(5).trim();
      if (!json || json === "[DONE]") continue;
      let obj;
      try {
        obj = JSON.parse(json);
      } catch {
        continue;
      }
      const delta =
        obj.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join("") ?? "";
      if (delta) {
        full += delta;
        onDelta?.(delta);
      }
    }
  }
  if (!full.trim()) throw new Error("전사 결과가 비어있습니다.");
  return full;
}

function Tag({ children }) {
  return (
    <span className="rounded-full bg-teal-50 px-2.5 py-0.5 text-xs font-medium text-teal-700">
      {children}
    </span>
  );
}

/* ── 설정: Gemini API 키 + 모델 ──────────────────────────── */
function Settings({ settings, onSave, onClose }) {
  const [apiKey, setApiKey] = useState(settings.apiKey);
  const [model, setModel] = useState(settings.model);
  const [sttApiKey, setSttApiKey] = useState(settings.sttApiKey);
  const [sttModel, setSttModel] = useState(settings.sttModel);

  const save = () => {
    localStorage.setItem("gemini_api_key", apiKey.trim());
    localStorage.setItem("gemini_model", model);
    localStorage.setItem("gemini_stt_api_key", sttApiKey.trim());
    localStorage.setItem("gemini_stt_model", sttModel);
    onSave({ apiKey: apiKey.trim(), model, sttApiKey: sttApiKey.trim(), sttModel });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center bg-slate-900/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-bold text-slate-800">설정</h2>
        <p className="mt-1 text-sm text-slate-500">
          Gemini API 키는 이 브라우저에만 저장되며 서버에 보관되지 않습니다.
        </p>

        <label className="mt-5 block text-sm font-medium text-slate-700">Gemini API 키</label>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="AIza..."
          className="mt-1.5 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
        />
        <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer"
          className="mt-1 inline-block text-xs text-teal-700 hover:underline">
          → Google AI Studio에서 키 발급
        </a>

        <label className="mt-5 block text-sm font-medium text-slate-700">모델</label>
        <select
          value={model}
          onChange={(e) => setModel(e.target.value)}
          className="mt-1.5 w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
        >
          {MODELS.map((m) => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
        </select>

        {/* 음성 전사 전용 (선택) */}
        <div className="mt-6 border-t border-slate-100 pt-5">
          <h3 className="text-sm font-semibold text-slate-700">음성 전사 전용 (선택)</h3>
          <p className="mt-1 text-xs text-slate-500">
            오디오 전사에 다른 키/모델을 쓰려면 입력하세요. 비워두면 위 설정을 그대로 사용합니다.
          </p>

          <label className="mt-4 block text-sm font-medium text-slate-700">전사용 API 키</label>
          <input
            type="password"
            value={sttApiKey}
            onChange={(e) => setSttApiKey(e.target.value)}
            placeholder="비워두면 위 요약용 키 사용"
            className="mt-1.5 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
          />

          <label className="mt-4 block text-sm font-medium text-slate-700">전사용 모델</label>
          <input
            list="stt-models"
            value={sttModel}
            onChange={(e) => setSttModel(e.target.value.trim())}
            placeholder="비워두면 위 요약용 모델과 동일"
            className="mt-1.5 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
          />
          <datalist id="stt-models">
            {MODELS.map((m) => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
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

/* ── 대시보드: 회의록 리스트 + 검색 ───────────────────────── */
function Dashboard({ onOpen, onNew }) {
  const [meetings, setMeetings] = useState(null);
  const [q, setQ] = useState("");

  useEffect(() => {
    const t = setTimeout(
      () => api(`/api/meetings?q=${encodeURIComponent(q)}`).then(setMeetings).catch(console.error),
      q ? 300 : 0,
    );
    return () => clearTimeout(t);
  }, [q]);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="제목, 내용, 태그로 검색…"
          className="flex-1 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm shadow-sm outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
        />
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
          <p className="text-slate-500">{q ? "검색 결과가 없습니다." : "아직 회의록이 없습니다."}</p>
          {!q && (
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

/* ── 새 회의록: 텍스트 입력 + 오디오 업로드(목업) ─────────── */
function NewMeeting({ settings, onDone, onCancel, onOpenSettings }) {
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [audioFile, setAudioFile] = useState(null);
  const [transcribing, setTranscribing] = useState(false);
  const [stage, setStage] = useState("");
  const [liveText, setLiveText] = useState(""); // 전사 실시간 진행 텍스트
  const liveRef = useRef(null);

  // 새 조각이 들어올 때마다 진행창을 맨 아래로 스크롤
  useEffect(() => {
    const el = liveRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [liveText]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState(null); // AI 요약 결과 (아직 미저장)
  const [error, setError] = useState(null);

  // 오디오 → 텍스트 (Gemini 멀티모달 전사). 결과를 입력란에 채운다.
  const transcribe = async () => {
    // 전사 전용 키/모델이 있으면 그걸, 없으면 요약용으로 폴백
    const sttKey = settings.sttApiKey || settings.apiKey;
    const sttModel = settings.sttModel || settings.model;
    if (!sttKey) {
      setError("먼저 설정에서 Gemini API 키를 입력해주세요.");
      return;
    }
    if (!/^gemini-[a-z0-9.-]+$/.test(sttModel)) {
      setError("전사용 모델 ID 형식이 올바르지 않습니다 (예: gemini-2.5-flash).");
      return;
    }
    if (audioFile.size > MAX_AUDIO_BYTES) {
      setError("오디오가 너무 큽니다 (최대 100MB). 더 짧은 파일을 사용하거나 잘라서 올려주세요.");
      return;
    }
    setTranscribing(true);
    setError(null);
    setLiveText("");
    try {
      // 1) 브라우저 → Gemini Files API 직접 업로드 → fileUri (업로드·전사는 같은 키여야 함)
      const { fileUri, mimeType } = await uploadAudioToGemini(audioFile, sttKey, setStage);
      // 2) 전사도 브라우저에서 직접, 스트리밍으로 조각마다 진행창 갱신
      setStage("전사 중…");
      const t = await transcribeWithGemini(fileUri, mimeType, sttKey, sttModel, (delta) =>
        setLiveText((prev) => prev + delta),
      );
      // 완료 → 전체 텍스트를 입력란으로 이동
      setText((prev) => (prev.trim() ? prev.trimEnd() + "\n\n" + t : t));
    } catch (e) {
      setError(e.message);
    } finally {
      setTranscribing(false);
      setStage("");
      setLiveText("");
    }
  };

  // 1단계: 요약 (DB 저장 안 함)
  const summarize = async () => {
    if (!settings.apiKey) {
      setError("먼저 설정에서 Gemini API 키를 입력해주세요.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await api("/api/summarize", {
        method: "POST",
        body: JSON.stringify({ title, text, apiKey: settings.apiKey, model: settings.model }),
      });
      setPreview(result);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  // 2단계: 미리보기 확인 후 저장
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const meeting = await api("/api/meetings", {
        method: "POST",
        body: JSON.stringify({ title, text, ...preview }),
      });
      onDone(meeting.id);
    } catch (e) {
      setError(e.message);
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
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

      {/* 오디오 업로드 → Gemini 전사 → 위 입력란에 텍스트 채움 */}
      <div className="flex items-center gap-3 rounded-xl border border-dashed border-slate-300 px-4 py-3">
        <label className="flex flex-1 cursor-pointer items-center gap-2 text-sm text-slate-500">
          {/* 일부 브라우저는 audio/* 만으로 .aac를 안 걸러줘서 확장자를 명시 */}
          <input type="file" accept="audio/*,.aac,.m4a,.mp3,.wav" className="hidden"
            onChange={(e) => setAudioFile(e.target.files?.[0] ?? null)} />
          <span>🎙️ {audioFile?.name ?? "오디오 파일 선택 (aac, m4a, mp3, wav · 최대 100MB)"}</span>
        </label>
        {audioFile && (
          <button
            onClick={transcribe}
            disabled={transcribing}
            className="shrink-0 rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-700 disabled:opacity-40"
          >
            {transcribing ? (stage || "변환 중…") : "🔤 텍스트로 변환"}
          </button>
        )}
      </div>

      {/* 전사 실시간 진행창 */}
      {transcribing && (
        <div className="rounded-xl border border-teal-200 bg-teal-50/40 p-4">
          <div className="flex items-center gap-2 text-xs font-semibold text-teal-700">
            <span className="inline-block size-2 animate-pulse rounded-full bg-teal-500" />
            {stage || "전사 중…"}
          </div>
          {liveText && (
            <pre
              ref={liveRef}
              className="mt-2 max-h-52 overflow-y-auto whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-700"
            >
              {liveText}
            </pre>
          )}
        </div>
      )}

      <div className="flex items-center justify-between rounded-xl bg-slate-100 px-4 py-2.5 text-xs text-slate-500">
        <span>
          {settings.apiKey
            ? `모델: ${MODELS.find((m) => m.id === settings.model)?.label ?? settings.model}`
            : "⚠️ API 키가 설정되지 않았습니다."}
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
              <label className="flex cursor-pointer items-start gap-3 rounded-xl px-3 py-2.5 hover:bg-slate-50">
                <input type="checkbox" checked={a.done} onChange={() => toggle(a)}
                  className="mt-0.5 size-4 accent-teal-700" />
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
export default function App() {
  // ponytail: 라우터 없이 view state로 화면 전환. URL 공유 필요해지면 react-router 도입.
  const [view, setView] = useState({ name: "list" });
  const [settings, setSettings] = useState(loadSettings);
  const [showSettings, setShowSettings] = useState(false);

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
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-8">
        {view.name === "list" && (
          <Dashboard onOpen={(id) => setView({ name: "detail", id })} onNew={() => setView({ name: "new" })} />
        )}
        {view.name === "new" && (
          <NewMeeting
            settings={settings}
            onDone={(id) => setView({ name: "detail", id })}
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
