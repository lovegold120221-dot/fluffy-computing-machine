import { auth } from "./firebase";

async function getHeaders() {
  const user = auth.currentUser;
  if (!user) return {};
  const token = await user.getIdToken();
  return {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${token}`
  };
}

async function readApiError(res: Response, fallback: string) {
  const errData = await res.json().catch(() => ({}));
  if (errData?.error?.message) return errData.error.message;
  if (typeof errData?.error === "string") return errData.error;
  return fallback;
}

export async function fetchSettings() {
  const headers = await getHeaders();
  const res = await fetch("/api/settings", { headers });
  if (!res.ok) {
    throw new Error(await readApiError(res, "Failed to fetch settings"));
  }
  return res.json();
}

export async function updateSettings(settings: any) {
  const headers = await getHeaders();
  const res = await fetch("/api/settings", {
    method: "PUT",
    headers,
    body: JSON.stringify(settings)
  });
  if (!res.ok) {
    throw new Error(await readApiError(res, "Failed to update settings"));
  }
  return res.json();
}

export async function fetchMemories() {
  const headers = await getHeaders();
  const res = await fetch("/api/memories", { headers });
  if (!res.ok) {
    throw new Error(await readApiError(res, "Failed to fetch memories"));
  }
  return res.json();
}

export async function saveMemory(content: string, type: string) {
  const headers = await getHeaders();
  const res = await fetch("/api/memories", {
    method: "POST",
    headers,
    body: JSON.stringify({ content, type })
  });
  if (!res.ok) {
    throw new Error(await readApiError(res, "Failed to save memory"));
  }
  return res.json();
}

export async function deleteMemory(id: number) {
  const headers = await getHeaders();
  const res = await fetch(`/api/memories/${id}`, {
    method: "DELETE",
    headers
  });
  if (!res.ok) throw new Error("Failed to delete memory");
  return res.json();
}

export async function fetchConversations(limit = 100) {
  const headers = await getHeaders();
  const res = await fetch(`/api/conversations?limit=${limit}`, { headers });
  if (!res.ok) {
    throw new Error(await readApiError(res, "Failed to fetch conversations"));
  }
  return res.json();
}

export async function saveConversationTurn(role: string, content: string, session_id?: string) {
  const headers = await getHeaders();
  const res = await fetch("/api/conversations", {
    method: "POST",
    headers,
    body: JSON.stringify({ role, content, session_id })
  });
  if (!res.ok) {
    throw new Error(await readApiError(res, "Failed to save turn"));
  }
  return res.json();
}

export async function fetchVpsStatus() {
  const headers = await getHeaders();
  const res = await fetch("/api/vps/status", { headers });
  if (!res.ok) {
    throw new Error(await readApiError(res, "Failed to fetch VPS status"));
  }
  return res.json();
}

export async function fetchVpsOllamaModels(target: "self" | "cloud" = "self") {
  const headers = await getHeaders();
  const res = await fetch(`/api/vps/ollama/models?target=${encodeURIComponent(target)}`, { headers });
  if (!res.ok) {
    throw new Error(await readApiError(res, "Failed to fetch Ollama models"));
  }
  return res.json();
}

export async function runVpsCommand(input: {
  command: string;
  cwd?: string;
  scope?: "sandbox" | "system";
  timeoutMs?: number;
  confirmSystem?: boolean;
}) {
  const headers = await getHeaders();
  const res = await fetch("/api/vps/terminal", {
    method: "POST",
    headers,
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    throw new Error(await readApiError(res, "Failed to run VPS command"));
  }
  return res.json();
}

export async function generateVpsOllama(input: {
  target?: "self" | "cloud";
  model?: string;
  prompt: string;
  system?: string;
  timeoutMs?: number;
}) {
  const headers = await getHeaders();
  const res = await fetch("/api/vps/ollama/generate", {
    method: "POST",
    headers,
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    throw new Error(await readApiError(res, "Failed to generate with VPS Ollama"));
  }
  return res.json();
}

export async function runVpsHermes(input: { prompt: string; timeoutMs?: number }) {
  const headers = await getHeaders();
  const res = await fetch("/api/vps/hermes/run", {
    method: "POST",
    headers,
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    throw new Error(await readApiError(res, "Failed to run Hermes agent"));
  }
  return res.json();
}

export async function runVpsSubAgents(input: {
  task: string;
  target?: "self" | "cloud";
  model?: string;
  agents?: Array<{ id?: string; name?: string; role?: string; model?: string }>;
  timeoutMs?: number;
}) {
  const headers = await getHeaders();
  const res = await fetch("/api/vps/subagents/run", {
    method: "POST",
    headers,
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    throw new Error(await readApiError(res, "Failed to run VPS sub-agents"));
  }
  return res.json();
}

export async function delegateBackgroundTask(input: {
  description: string;
  type: "terminal" | "ollama" | "hermes" | "subagents";
  params: Record<string, any>;
  timeoutMs?: number;
}) {
  const headers = await getHeaders();
  const res = await fetch("/api/tasks/delegate", {
    method: "POST",
    headers,
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    throw new Error(await readApiError(res, "Failed to delegate task"));
  }
  return res.json();
}

export async function fetchTaskStatus(taskId: string) {
  const headers = await getHeaders();
  const res = await fetch(`/api/tasks/status/${taskId}`, { headers });
  if (!res.ok) {
    throw new Error(await readApiError(res, "Failed to fetch task status"));
  }
  return res.json();
}

export async function fetchActiveTasks() {
  const headers = await getHeaders();
  const res = await fetch("/api/tasks/active", { headers });
  if (!res.ok) {
    throw new Error(await readApiError(res, "Failed to fetch active tasks"));
  }
  return res.json();
}
