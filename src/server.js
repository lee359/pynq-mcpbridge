import crypto from "node:crypto";
import express from "express";
import WebSocket from "ws";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const rawBaseUrl = process.env.JUPYTER_URL ?? "http://192.168.3.1:9090";
const baseUrl = rawBaseUrl.replace(/\/$/, "");
const token = process.env.JUPYTER_TOKEN;
const password = process.env.JUPYTER_PASSWORD;
const port = Number(process.env.MCP_PORT ?? 8787);
let loginCookie;
let xsrfToken;

function apiUrl(path, query = {}) {
  const url = new URL(`${baseUrl}${path}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
  }
  // PYNQ's commonly shipped notebook server accepts token as a query parameter
  // for both REST and kernel-channel requests.
  if (token) url.searchParams.set("token", token);
  return url;
}

function cookiesFrom(response) {
  const setCookies = response.headers.getSetCookie?.() ?? (response.headers.get("set-cookie") ? [response.headers.get("set-cookie")] : []);
  const cookies = new Map((loginCookie ?? "").split(/;\s*/).filter(Boolean).map((item) => item.split("=", 2)));
  for (const value of setCookies) {
    const [pair] = value.split(";", 1);
    const [name, cookieValue] = pair.split("=", 2);
    if (name && cookieValue !== undefined) cookies.set(name, cookieValue);
  }
  loginCookie = [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  xsrfToken = cookies.get("_xsrf") ?? xsrfToken;
}

async function ensureLogin() {
  if (token || !password || loginCookie?.includes("username-")) return;
  const login = await fetch(`${baseUrl}/login?next=%2Flab`, { redirect: "manual" });
  cookiesFrom(login);
  const html = await login.text();
  const formToken = html.match(/name=["']_xsrf["']\s+value=["']([^"']+)/)?.[1] ?? xsrfToken;
  if (!formToken) throw new Error("Jupyter login page did not provide an XSRF token.");
  const form = new URLSearchParams({ password, _xsrf: formToken });
  const response = await fetch(`${baseUrl}/login?next=%2Flab`, {
    method: "POST", redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: loginCookie, "X-XSRFToken": formToken },
    body: form,
  });
  cookiesFrom(response);
  if (![302, 303].includes(response.status) || !loginCookie?.includes("username-")) {
    throw new Error("Jupyter password login failed. Check JUPYTER_PASSWORD.");
  }
}

function apiHeaders(extra = {}) {
  return {
    Accept: "application/json",
    ...(token ? { Authorization: `token ${token}` } : {}),
    ...(loginCookie ? { Cookie: loginCookie } : {}),
    ...(xsrfToken ? { "X-XSRFToken": xsrfToken } : {}),
    ...extra,
  };
}

async function jupyter(path, options = {}) {
  await ensureLogin();
  const response = await fetch(apiUrl(path, options.query), {
    method: options.method ?? "GET",
    headers: apiHeaders(options.body ? { "Content-Type": "application/json" } : {}),
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  cookiesFrom(response);
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Jupyter ${response.status} ${response.statusText}: ${detail.slice(0, 500)}`);
  }
  return response.status === 204 ? null : response.json();
}

function textResult(value) {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

function errorResult(error) {
  return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
}

async function listNotebookFiles(path, recursive) {
  const normalized = path.replace(/^\/+|\/+$/g, "");
  const result = [];
  const pending = [normalized];
  while (pending.length) {
    const directory = pending.shift();
    const entries = await jupyter(`/api/contents/${encodeURI(directory)}`, { query: { content: 0 } });
    if (entries.type === "notebook") {
      result.push({ path: entries.path, name: entries.name, last_modified: entries.last_modified });
      continue;
    }
    for (const entry of entries.content ?? []) {
      if (entry.type === "notebook") result.push({ path: entry.path, name: entry.name, last_modified: entry.last_modified });
      if (recursive && entry.type === "directory") pending.push(entry.path);
    }
  }
  return result;
}

async function kernelForNotebook(path) {
  const active = await jupyter("/api/sessions");
  const match = active.find((session) => session.path === path && session.kernel?.id);
  if (match) return { kernelId: match.kernel.id, sessionId: match.kernel.id };

  const kernels = await jupyter("/api/kernelspecs");
  const kernelName = kernels.default ?? Object.keys(kernels.kernelspecs ?? {})[0];
  if (!kernelName) throw new Error("No kernel is available on the Jupyter server.");
  const created = await jupyter("/api/sessions", {
    method: "POST",
    body: { path, name: path.split("/").at(-1), type: "notebook", kernel: { name: kernelName } },
  });
  return { kernelId: created.kernel.id, sessionId: created.kernel.id };
}

async function executeInKernel(kernelId, code) {
  await ensureLogin();
  const wsUrl = apiUrl(`/api/kernels/${kernelId}/channels`);
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  const messageId = crypto.randomUUID();
  const clientSession = crypto.randomUUID();
  const outputs = [];

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("Timed out waiting for the Jupyter kernel (30 seconds)."));
    }, 30_000);
    const socket = new WebSocket(wsUrl, { headers: apiHeaders() });
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
    socket.once("open", () => {
      socket.send(JSON.stringify({
        header: { msg_id: messageId, username: "codex", session: clientSession, msg_type: "execute_request", version: "5.3" },
        parent_header: {}, metadata: {},
        content: { code, silent: false, store_history: true, user_expressions: {}, allow_stdin: false, stop_on_error: true },
      }));
    });
    socket.on("message", (buffer) => {
      const message = JSON.parse(buffer.toString());
      if (message.parent_header?.msg_id !== messageId) return;
      if (["stream", "execute_result", "display_data", "error", "execute_reply"].includes(message.header?.msg_type)) {
        outputs.push({ type: message.header.msg_type, content: message.content });
      }
      if (message.header?.msg_type === "status" && message.content?.execution_state === "idle") {
        clearTimeout(timer);
        socket.close();
        resolve(outputs);
      }
    });
  });
}

function createServer() {
  const server = new McpServer({ name: "pynq-jupyter-bridge", version: "0.1.0" }, {
    instructions: "Use list_notebooks and read_notebook before executing code. execute_cell runs arbitrary code on the attached PYNQ board; confirm the target notebook and requested hardware action with the user.",
  });

  server.tool("list_notebooks", "List notebooks on the PYNQ Jupyter server.", {
    path: z.string().default(""), recursive: z.boolean().default(false),
  }, async ({ path, recursive }) => {
    try { return textResult(await listNotebookFiles(path, recursive)); } catch (error) { return errorResult(error); }
  });

  server.tool("read_notebook", "Read a notebook's complete .ipynb JSON from the PYNQ Jupyter server.", {
    path: z.string().min(1),
  }, async ({ path }) => {
    try {
      const notebook = await jupyter(`/api/contents/${encodeURI(path)}`, { query: { content: 1 } });
      if (notebook.type !== "notebook") throw new Error(`Not a notebook: ${path}`);
      return textResult(notebook.content);
    } catch (error) { return errorResult(error); }
  });

  server.tool("execute_cell", "Execute Python code in a notebook's live kernel on the PYNQ board and return its outputs.", {
    path: z.string().min(1),
    code: z.string().min(1).describe("Python code to execute. Copy an existing cell exactly when possible."),
  }, async ({ path, code }) => {
    try {
      const { kernelId } = await kernelForNotebook(path);
      return textResult({ notebook: path, kernel_id: kernelId, outputs: await executeInKernel(kernelId, code) });
    } catch (error) { return errorResult(error); }
  });
  return server;
}

const app = express();
app.use(express.json({ limit: "2mb" }));
app.get("/health", async (_request, response) => {
  try {
    const info = await jupyter("/api");
    response.json({ ok: true, jupyter: info.version ?? "reachable" });
  } catch (error) { response.status(502).json({ ok: false, error: String(error) }); }
});

app.post("/mcp", async (request, response) => {
  // Stateless Streamable HTTP is ideal here: Jupyter authentication and kernels
  // are retained separately, while each MCP request gets an isolated protocol instance.
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  const server = createServer();
  await server.connect(transport);
  return transport.handleRequest(request, response, request.body);
});

app.get("/mcp", (_request, response) => response.status(405).send("Stateless MCP uses POST."));
app.delete("/mcp", (_request, response) => response.status(405).send("Stateless MCP uses POST."));

app.listen(port, "127.0.0.1", () => console.log(`PYNQ Jupyter MCP bridge: http://127.0.0.1:${port}/mcp`));
