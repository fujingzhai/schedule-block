/** 思源内核 API 封装。挂件与思源同源，正常情况下凭会话即可调用；
 *  独立调试时可在 URL 上带 ?token=xxx。 */

const TOKEN = new URLSearchParams(window.location.search).get("token") || "";

function authHeaders(): Record<string, string> {
  return TOKEN ? { Authorization: `Token ${TOKEN}` } : {};
}

interface KernelResponse<T = unknown> {
  code: number;
  msg: string;
  data: T;
}

async function kernel<T = unknown>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: body === undefined ? "{}" : JSON.stringify(body)
  });
  const data = (await res.json()) as KernelResponse<T>;
  if (data.code !== 0) {
    throw new Error(data.msg || `${path} 调用失败`);
  }
  return data.data;
}

export function getBlockAttrs(id: string): Promise<Record<string, string>> {
  return kernel<Record<string, string>>("/api/attr/getBlockAttrs", { id });
}

export function setBlockAttrs(id: string, attrs: Record<string, string>): Promise<unknown> {
  return kernel("/api/attr/setBlockAttrs", { id, attrs });
}

/** 读工作区文件，不存在时返回 null */
export async function readWorkspaceFile(path: string): Promise<string | null> {
  const res = await fetch("/api/file/getFile", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ path })
  });
  const text = await res.text();
  if (!res.ok) {
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && "code" in parsed && "msg" in parsed && parsed.code !== 0) {
      return null;
    }
  } catch {
    // 文件内容不是 JSON —— 直接返回原文
  }
  return text;
}

export async function writeWorkspaceFile(path: string, content: string): Promise<void> {
  const form = new FormData();
  form.append("path", path);
  form.append("isDir", "false");
  form.append("modTime", String(Date.now()));
  form.append("file", new Blob([content], { type: "application/json" }), path.split("/").pop() || "file");
  const res = await fetch("/api/file/putFile", {
    method: "POST",
    headers: authHeaders(),
    body: form
  });
  const data = (await res.json()) as KernelResponse;
  if (data.code !== 0) {
    throw new Error(data.msg || "保存文件失败");
  }
}

const BLOCK_ID_RE = /^\d{14}-[a-z0-9]{7}$/;
function isBlockID(value: string): boolean {
  return BLOCK_ID_RE.test(value);
}

export async function getDocTitle(blockId: string): Promise<string> {
  if (!isBlockID(blockId)) {
    return "";
  }
  try {
    const rows = await kernel<any[]>("/api/query/sql", {
      stmt: `SELECT content FROM blocks WHERE id = (SELECT root_id FROM blocks WHERE id = '${blockId}' LIMIT 1) LIMIT 1`
    });
    return rows?.[0]?.content || "";
  } catch {
    return "";
  }
}

/** 从挂件块 ID 获取其所属文档的 root_id */
export async function getRootId(blockId: string): Promise<string> {
  if (!isBlockID(blockId)) {
    return "";
  }
  try {
    const rows = await kernel<any[]>("/api/query/sql", {
      stmt: `SELECT root_id FROM blocks WHERE id='${blockId}' LIMIT 1`
    });
    const rootId = rows?.[0]?.root_id || "";
    return isBlockID(rootId) ? rootId : "";
  } catch {
    return "";
  }
}
