// 서버리스 핸들러를 감싸 예외를 JSON 에러로 반환한다.
// Vercel은 잡히지 않은 예외를 그냥 500 크래시로 처리해 원인이 사라지므로,
// 여기서 잡아 { error: 메시지 }로 내려 원인 파악이 가능하게 한다.

// postgres는 연결 실패 시 message가 빈 AggregateError를 던지기도 해서, 여러 곳에서 원인을 긁는다.
const detail = (e) =>
  e?.message ||
  e?.errors?.map((x) => x?.message).filter(Boolean).join("; ") ||
  e?.cause?.message ||
  e?.code ||
  String(e) ||
  "server error";

export const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.status(500).json({ error: detail(e) });
  }
};
