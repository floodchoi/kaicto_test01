// 로컬 전용: Vercel 서버리스 함수를 그대로 돌리는 초소형 어댑터.
// 실행: node --env-file=.env dev-server.js  (배포 시엔 Vercel이 /api를 직접 서빙)
import http from "node:http";
import meetings from "./api/meetings.js";
import meetingById from "./api/meetings/[id].js";

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  res.status = (c) => ((res.statusCode = c), res);
  res.json = (o) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(o));
  };
  req.query = Object.fromEntries(url.searchParams);
  let body = "";
  for await (const chunk of req) body += chunk;
  req.body = body ? JSON.parse(body) : undefined;

  const idMatch = url.pathname.match(/^\/api\/meetings\/(\d+)$/);
  try {
    if (url.pathname === "/api/meetings") await meetings(req, res);
    else if (idMatch) ((req.query.id = idMatch[1]), await meetingById(req, res));
    else res.status(404).json({ error: "not found" });
  } catch (e) {
    console.error(e);
    if (!res.writableEnded) res.status(500).json({ error: e.message });
  }
});

const port = process.env.PORT || 3001;
server.listen(port, () => console.log(`API ready → http://localhost:${port}`));
