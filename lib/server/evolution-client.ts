// ── Evolution API Client for WhatsApp Integration ──
// Doc: https://doc.evolution-api.com

function getEvoUrl() { return process.env.EVOLUTION_API_URL || ""; }
function getEvoKey() { return process.env.EVOLUTION_API_KEY || ""; }
function getWebhookSecret() { return process.env.EVOLUTION_WEBHOOK_SECRET || ""; }
function getBackendUrl() { return process.env.PUBLIC_BACKEND_URL || "http://localhost:3000"; }

export interface EvolutionInstance {
  instanceName: string;
  status: string;
  qrcode?: { base64?: string; pairingCode?: string };
  integration?: string;
  number?: string;
}

export interface EvolutionWebhook {
  url: string;
  events: string[];
  enabled: boolean;
}

// ── Helpers ──

function evoUrl(path: string): string {
  return `${getEvoUrl()}${path}`;
}

export async function evolutionRequest<T = any>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const url = evoUrl(path);
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      apikey: getEvoKey(),
      ...(options.headers || {}),
    },
  });

  const text = await res.text();
  let data: any = null;
  try { data = JSON.parse(text); } catch {}

  if (!res.ok) {
    throw new Error(
      `Evolution API error ${res.status}: ${data ? JSON.stringify(data) : text}`,
    );
  }
  return data as T;
}

export function verifyWebhookSecret(secret: string): boolean {
  const s = getWebhookSecret();
  return s && secret === s;
}

// ── Instance Management ──

/**
 * Create a new Evolution instance.
 */
export async function createInstance(
  instanceName: string,
  webhookUrl?: string,
): Promise<any> {
  const webhook: EvolutionWebhook | undefined = webhookUrl
    ? {
        url: webhookUrl,
        events: [
          "QRCODE_UPDATED",
          "CONNECTION_UPDATE",
          "MESSAGES_UPSERT",
          "SEND_MESSAGE",
        ],
        enabled: true,
      }
    : undefined;

  return evolutionRequest("/instance/create", {
    method: "POST",
    body: JSON.stringify({
      instanceName,
      qrcode: true,
      integration: "WHATSAPP-BAILEYS",
      ...(webhook ? { webhook } : {}),
    }),
  });
}

/**
 * Fetch QR code for an instance. Returns { pairingCode, base64 }.
 */
export async function fetchQRCode(instanceName: string): Promise<{
  pairingCode?: string;
  base64?: string;
}> {
  return evolutionRequest(`/instance/connect/${instanceName}`, {
    method: "GET",
  });
}

/**
 * Get connection state for an instance.
 */
export async function fetchConnectionState(
  instanceName: string,
): Promise<{ instance: { state: string; statusReason?: number } }> {
  return evolutionRequest(
    `/instance/connectionState/${instanceName}`,
    { method: "GET" },
  );
}

/**
 * Send a text message through a connected instance.
 */
export async function sendMessage(
  instanceName: string,
  number: string,
  text: string,
): Promise<any> {
  return evolutionRequest("/message/sendText/" + instanceName, {
    method: "POST",
    body: JSON.stringify({ number, text }),
  });
}

/**
 * Logout from the instance (disconnect WhatsApp session).
 */
export async function logoutInstance(instanceName: string): Promise<any> {
  return evolutionRequest(`/instance/logout/${instanceName}`, {
    method: "DELETE",
  });
}

/**
 * Delete an instance entirely.
 */
export async function deleteInstance(instanceName: string): Promise<any> {
  return evolutionRequest(`/instance/delete/${instanceName}`, {
    method: "DELETE",
  });
}

/**
 * Restart an instance.
 */
export async function restartInstance(instanceName: string): Promise<any> {
  return evolutionRequest(`/instance/restart/${instanceName}`, {
    method: "PUT",
  });
}

// ── Connection Status Normalization ──

export type BeatriceConnectionStatus =
  | "not_connected"
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";

export function normalizeEvolutionState(
  state: string,
): BeatriceConnectionStatus {
  switch (state.toLowerCase()) {
    case "open":
      return "connected";
    case "connecting":
      return "connecting";
    case "close":
    case "closed":
      return "disconnected";
    default:
      return "disconnected";
  }
}
