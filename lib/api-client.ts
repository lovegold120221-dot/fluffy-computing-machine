import { auth } from "./firebase";

async function getHeaders() {
  const user = auth.currentUser;
  if (!user) {
    throw new Error("No authenticated Firebase user.");
  }
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

export async function fetchCurrentUser() {
  const headers = await getHeaders();
  const res = await fetch("/api/me", { headers });
  if (!res.ok) {
    throw new Error(await readApiError(res, "Failed to fetch current user"));
  }
  return res.json();
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

export async function fetchConversations(limit = 100, options: { session_id?: string; q?: string } = {}) {
  const headers = await getHeaders();
  const params = new URLSearchParams({ limit: String(limit) });
  if (options.session_id) params.set("session_id", options.session_id);
  if (options.q) params.set("q", options.q);
  const res = await fetch(`/api/conversations?${params.toString()}`, { headers });
  if (!res.ok) {
    throw new Error(await readApiError(res, "Failed to fetch conversations"));
  }
  return res.json();
}

export async function fetchConversationContext(limit = 60) {
  const headers = await getHeaders();
  const res = await fetch(`/api/conversations/context?limit=${encodeURIComponent(String(limit))}`, { headers });
  if (!res.ok) {
    throw new Error(await readApiError(res, "Failed to fetch conversation context"));
  }
  return res.json();
}

export type ConversationSource = "voice" | "text" | "tool" | "system" | "import";

export type ConversationTurnInput = {
  session_id?: string;
  client_turn_id?: string;
  source?: ConversationSource;
  metadata?: Record<string, unknown>;
  created_at?: string;
};

export async function saveConversationTurn(
  role: string,
  content: string,
  options?: string | ConversationTurnInput
) {
  const headers = await getHeaders();
  const normalizedOptions = typeof options === "string" ? { session_id: options } : (options || {});
  const res = await fetch("/api/conversations", {
    method: "POST",
    headers,
    body: JSON.stringify({ role, content, ...normalizedOptions })
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

export async function createAutomation(input: {
  title: string;
  description: string;
  schedule: { type: string; time?: string; timezone?: string };
  agent?: string;
  input?: Record<string, any>;
  output?: Record<string, any>;
}) {
  const headers = await getHeaders();
  const res = await fetch("/api/automations", {
    method: "POST",
    headers,
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await readApiError(res, "Failed to create automation"));
  return res.json();
}

export async function fetchAutomations() {
  const headers = await getHeaders();
  const res = await fetch("/api/automations", { headers });
  if (!res.ok) throw new Error(await readApiError(res, "Failed to fetch automations"));
  return res.json();
}

export async function fetchAutomation(id: string) {
  const headers = await getHeaders();
  const res = await fetch(`/api/automations/${id}`, { headers });
  if (!res.ok) throw new Error(await readApiError(res, "Failed to fetch automation"));
  return res.json();
}

export async function updateAutomation(id: string, updates: Record<string, any>) {
  const headers = await getHeaders();
  const res = await fetch(`/api/automations/${id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify(updates),
  });
  if (!res.ok) throw new Error(await readApiError(res, "Failed to update automation"));
  return res.json();
}

export async function deleteAutomation(id: string) {
  const headers = await getHeaders();
  const res = await fetch(`/api/automations/${id}`, {
    method: "DELETE",
    headers,
  });
  if (!res.ok) throw new Error(await readApiError(res, "Failed to delete automation"));
  return res.json();
}

export async function runAutomationNow(id: string) {
  const headers = await getHeaders();
  const res = await fetch(`/api/automations/${id}/run`, {
    method: "POST",
    headers,
  });
  if (!res.ok) throw new Error(await readApiError(res, "Failed to run automation"));
  return res.json();
}

export async function fetchAutomationRuns(id: string) {
  const headers = await getHeaders();
  const res = await fetch(`/api/automations/${id}/runs`, { headers });
  if (!res.ok) throw new Error(await readApiError(res, "Failed to fetch automation runs"));
  return res.json();
}

// ── Google Token Persistence (Supabase) ──

export async function saveGoogleToken(accessToken: string, refreshToken?: string, expiresAt?: number) {
  const headers = await getHeaders();
  const res = await fetch("/api/google-token", {
    method: "POST",
    headers,
    body: JSON.stringify({ access_token: accessToken, refresh_token: refreshToken, expires_at: expiresAt }),
  });
  if (!res.ok) throw new Error(await readApiError(res, "Failed to save Google token"));
  return res.json();
}

export async function fetchGoogleToken(): Promise<{ access_token: string; refresh_token?: string; expires_at?: number }> {
  const headers = await getHeaders();
  const res = await fetch("/api/google-token", { headers });
  if (!res.ok) throw new Error(await readApiError(res, "Failed to fetch Google token"));
  return res.json();
}

export async function refreshGoogleToken(): Promise<{ access_token: string; expires_at?: number }> {
  const headers = await getHeaders();
  const res = await fetch("/api/google-token/refresh", {
    method: "POST",
    headers,
  });
  if (!res.ok) throw new Error(await readApiError(res, "Failed to refresh Google token"));
  return res.json();
}

// ── WhatsApp Integration ──

export async function connectWhatsApp(): Promise<{
  status: string;
  instanceName: string;
  qrBase64?: string;
  pairingCode?: string;
}> {
  const headers = await getHeaders();
  const res = await fetch("/api/whatsapp/connect", {
    method: "POST",
    headers,
  });
  if (!res.ok) throw new Error(await readApiError(res, "Failed to connect WhatsApp"));
  return res.json();
}

export async function fetchWhatsAppStatus(): Promise<{
  status: string;
  instanceName: string | null;
  phoneNumber?: string;
}> {
  const headers = await getHeaders();
  const res = await fetch("/api/whatsapp/status", { headers });
  if (!res.ok) throw new Error(await readApiError(res, "Failed to fetch WhatsApp status"));
  return res.json();
}

export async function sendWhatsAppMessage(number: string, text: string) {
  const headers = await getHeaders();
  const res = await fetch("/api/whatsapp/send", {
    method: "POST",
    headers,
    body: JSON.stringify({ number, text }),
  });
  if (!res.ok) throw new Error(await readApiError(res, "Failed to send WhatsApp message"));
  return res.json();
}

export async function disconnectWhatsApp() {
  const headers = await getHeaders();
  const res = await fetch("/api/whatsapp/disconnect", {
    method: "POST",
    headers,
  });
  if (!res.ok) throw new Error(await readApiError(res, "Failed to disconnect WhatsApp"));
  return res.json();
}

// ── WhatsApp Phonebook API ──

export async function fetchWhatsAppPhonebook(): Promise<{
  success: boolean;
  contacts: { id: string; phoneNumber: string; name: string; pushname?: string }[];
  count: number;
  instanceName: string | null;
}> {
  const headers = await getHeaders();
  const res = await fetch("/api/whatsapp/phonebook", { headers });
  if (!res.ok) {
    throw new Error(await readApiError(res, "Failed to fetch WhatsApp phonebook"));
  }
  return res.json();
}

// ── WhatsApp Activities API ──

export type WhatsAppActivity = {
  id: number;
  user_id: string;
  instance_name: string;
  activity_type: string;
  direction: string;
  phone_number?: string;
  content?: string;
  status: string;
  source?: string;
  metadata?: Record<string, any>;
  created_at: string;
};

export async function fetchWhatsAppActivities(options: {
  limit?: number;
  type?: string;
  direction?: string;
} = {}): Promise<{
  success: boolean;
  activities: WhatsAppActivity[];
  count: number;
}> {
  const headers = await getHeaders();
  const params = new URLSearchParams();
  if (options.limit) params.set("limit", String(options.limit));
  if (options.type) params.set("type", options.type);
  if (options.direction) params.set("direction", options.direction);
  
  const res = await fetch(`/api/whatsapp/activities?${params.toString()}`, { headers });
  if (!res.ok) {
    throw new Error(await readApiError(res, "Failed to fetch WhatsApp activities"));
  }
  return res.json();
}

// ── Cartesia Voice API ──

export async function generateCartesiaVoice(
  text: string,
  language?: string,
  emotion?: string,
  speed?: number,
  volume?: number
): Promise<{
  success: boolean;
  audioBase64: string;
  voiceId: string;
  format: string;
  sampleRate: number;
  encoding: string;
}> {
  const headers = await getHeaders();
  const res = await fetch("/api/cartesia/generate-voice", {
    method: "POST",
    headers,
    body: JSON.stringify({ text, language, emotion, speed, volume }),
  });
  if (!res.ok) {
    throw new Error(await readApiError(res, "Failed to generate Cartesia voice"));
  }
  return res.json();
}

// ── WhatsApp Voice Message API ──

export async function sendWhatsAppVoiceMessage(
  phoneNumber: string,
  audioBase64: string,
  caption?: string,
  instanceName: string = 'beatrice'
): Promise<any> {
  const headers = await getHeaders();
  const res = await fetch("/api/whatsapp/send-voice", {
    method: "POST",
    headers,
    body: JSON.stringify({ phoneNumber, audioBase64, caption, instanceName }),
  });
  if (!res.ok) {
    throw new Error(await readApiError(res, "Failed to send WhatsApp voice message"));
  }
  return res.json();
}

// ── WhatsApp Call API ──

export async function initiateWhatsAppCall(
  phoneNumber: string,
  callType: 'voice' | 'video' = 'voice',
  instanceName: string = 'beatrice'
): Promise<any> {
  const headers = await getHeaders();
  const res = await fetch("/api/whatsapp/initiate-call", {
    method: "POST",
    headers,
    body: JSON.stringify({ phoneNumber, callType, instanceName }),
  });
  if (!res.ok) {
    throw new Error(await readApiError(res, "Failed to initiate WhatsApp call"));
  }
  return res.json();
}

// ── WhatsApp Tool API (for Gemini Live audio function calling) ──

export async function searchWhatsAppMessages(
  phoneNumber: string,
  query?: string,
  limit: number = 20
): Promise<{
  success: boolean;
  messages: any[];
  count: number;
  instanceName: string | null;
}> {
  const headers = await getHeaders();
  const res = await fetch("/api/whatsapp/search", {
    method: "POST",
    headers,
    body: JSON.stringify({ phoneNumber, query, limit }),
  });
  if (!res.ok) {
    throw new Error(await readApiError(res, "Failed to search WhatsApp messages"));
  }
  return res.json();
}

export async function readWhatsAppChat(
  phoneNumber: string,
  limit: number = 30
): Promise<{
  success: boolean;
  messages: any[];
  contactId: string;
  instanceName: string | null;
}> {
  const headers = await getHeaders();
  const res = await fetch("/api/whatsapp/read", {
    method: "POST",
    headers,
    body: JSON.stringify({ phoneNumber, limit }),
  });
  if (!res.ok) {
    throw new Error(await readApiError(res, "Failed to read WhatsApp chat"));
  }
  return res.json();
}

export async function getWhatsAppInstanceStatus(): Promise<{
  success: boolean;
  connected: boolean;
  instanceName: string | null;
  phoneNumber?: string;
  status?: string;
}> {
  const headers = await getHeaders();
  const res = await fetch("/api/whatsapp/instance-status", {
    method: "POST",
    headers,
  });
  if (!res.ok) {
    throw new Error(await readApiError(res, "Failed to get WhatsApp instance status"));
  }
  return res.json();
}

export async function getWhatsAppContacts(
  limit: number = 50
): Promise<{
  success: boolean;
  contacts: any[];
  count: number;
  instanceName: string | null;
}> {
  const headers = await getHeaders();
  const res = await fetch("/api/whatsapp/contacts", {
    method: "POST",
    headers,
    body: JSON.stringify({ limit }),
  });
  if (!res.ok) {
    throw new Error(await readApiError(res, "Failed to get WhatsApp contacts"));
  }
  return res.json();
}
