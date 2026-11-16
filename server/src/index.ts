import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { getFlow } from "./flow.ts";

const dist = new URL("../../client/dist/", import.meta.url);
await readFile(new URL("index.html", dist));

const contentTypes: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
};

const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 3000);

createServer(async (request, response) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  if (request.method !== "GET") {
    response.writeHead(405, { Allow: "GET" }).end();
    return;
  }

  const pathname = request.url?.split("?")[0];
  if (pathname === "/api/flow") {
    const data = await getFlow();
    response.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    }).end(JSON.stringify(data));
    return;
  }

  const asset = pathname === "/" ? "index.html"
    : /^\/assets\/[a-zA-Z0-9_.-]+\.(js|css)$/.test(pathname ?? "") ? pathname?.slice(1)
    : undefined;
  if (!asset) {
    response.writeHead(404).end();
    return;
  }

  try {
    const content = await readFile(new URL(asset, dist));
    const extension = asset.slice(asset.lastIndexOf(".") + 1);
    response.writeHead(200, {
      "Content-Type": contentTypes[extension] ?? "application/octet-stream",
      "Cache-Control": asset === "index.html" ? "no-cache" : "public, max-age=31536000, immutable",
    }).end(content);
  } catch {
    response.writeHead(404).end();
  }
}).listen(port, host, () => console.log(`http://${host}:${port}`));
