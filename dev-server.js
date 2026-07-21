// 로컬 전용: Vercel 서버리스 함수를 그대로 돌리는 초소형 어댑터.
// 실행: node --env-file=.env dev-server.js  (배포 시엔 Vercel이 /api를 직접 서빙)
import http from "node:http";
import auth from "./api/auth.js";
import me from "./api/me.js";
import adminUsers from "./api/admin-users.js";
import inviteCodes from "./api/invite-codes.js";
import projects from "./api/projects.js";
import meetings from "./api/meetings.js";
import actionItems from "./api/action-items.js";
import meetingById from "./api/meetings/[id].js";
import migrate from "./api/migrate.js";
import users from "./api/users.js";
import log from "./api/log.js";
import integrations from "./api/integrations.js";

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
    if (url.pathname === "/api/auth") await auth(req, res);
    else if (url.pathname === "/api/me") await me(req, res);
    else if (url.pathname === "/api/admin-users") await adminUsers(req, res);
    else if (url.pathname === "/api/invite-codes") await inviteCodes(req, res);
    else if (url.pathname === "/api/projects") await projects(req, res);
    else if (url.pathname === "/api/action-items") await actionItems(req, res);
    else if (url.pathname === "/api/meetings") await meetings(req, res);
    else if (url.pathname === "/api/migrate") await migrate(req, res);
    else if (url.pathname === "/api/users") await users(req, res);
    else if (url.pathname === "/api/log") await log(req, res);
    else if (url.pathname === "/api/integrations") await integrations(req, res);
    else if (idMatch) ((req.query.id = idMatch[1]), await meetingById(req, res));
    else res.status(404).json({ error: "not found" });
  } catch (e) {
    console.error(e);
    if (!res.writableEnded) res.status(500).json({ error: e.message });
  }
});

const port = process.env.PORT || 3001;
server.listen(port, () => console.log(`API ready → http://localhost:${port}`));
