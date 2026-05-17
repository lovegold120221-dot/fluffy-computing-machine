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

export interface WhatsAppMessage {
  key: {
    remoteJid: string;
    fromMe: boolean;
    id?: string;
  };
  message?: object;
  messageType?: string;
  messageTimestamp?: number;
  quote?: string;
  pushname?: string;
  type?: string;
}

export interface WhatsAppContact {
  id: string;
  pushname?: string;
  verifiedName?: string;
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

export async function fetchQRCode(instanceName: string): Promise<{
  pairingCode?: string;
  base64?: string;
}> {
  return evolutionRequest(`/instance/connect/${instanceName}`, {
    method: "GET",
  });
}

export async function fetchConnectionState(
  instanceName: string,
): Promise<{ instance: { state: string; statusReason?: number } }> {
  return evolutionRequest(
    `/instance/connectionState/${instanceName}`,
    { method: "GET" },
  );
}

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

export async function logoutInstance(instanceName: string): Promise<any> {
  return evolutionRequest(`/instance/logout/${instanceName}`, {
    method: "DELETE",
  });
}

export async function deleteInstance(instanceName: string): Promise<any> {
  return evolutionRequest(`/instance/delete/${instanceName}`, {
    method: "DELETE",
  });
}

export async function restartInstance(instanceName: string): Promise<any> {
  return evolutionRequest(`/instance/restart/${instanceName}`, {
    method: "PUT",
  });
}

// ── WhatsApp Message Operations ──

/**
 * Search WhatsApp messages from a contact.
 * Note: Evolution API doesn't have direct search, so we fetch recent messages.
 */
export async function searchWhatsAppMessages(
  instanceName: string,
  phoneNumber: string,
  query?: string,
  limit: number = 20,
): Promise<{ messages: WhatsAppMessage[]; count: number }> {
  const chatId = `${phoneNumber}@s.whatsapp.net`;
  
  // Fetch recent messages for this contact
  const messagesResponse = await evolutionRequest<{ messages: WhatsAppMessage[] }>(
    `/message/findMessages/${instanceName}`,
    {
      method: "POST",
      body: JSON.stringify({
        number: phoneNumber,
        count: limit,
      }),
    }
  );

  let messages = messagesResponse.messages || [];

  // Filter by query if provided
  if (query) {
    messages = messages.filter(msg => {
      const msgText = JSON.stringify(msg).toLowerCase();
      return msgText.includes(query.toLowerCase());
    });
  }

  return {
    messages: messages.slice(0, limit),
    count: messages.length,
  };
}

/**
 * Read/retrieve chat history with a contact.
 */
export async function readWhatsAppChat(
  instanceName: string,
  phoneNumber: string,
  limit: number = 30,
): Promise<{ messages: WhatsAppMessage[]; contactId: string }> {
  const chatId = `${phoneNumber}@s.whatsapp.net`;
  
  const messagesResponse = await evolutionRequest<{ messages: WhatsAppMessage[] }>(
    `/message/findMessages/${instanceName}`,
    {
      method: "POST",
      body: JSON.stringify({
        number: phoneNumber,
        count: limit,
      }),
    }
  );

  return {
    messages: messagesResponse.messages || [],
    contactId: chatId,
  };
}

/**
 * Get WhatsApp contacts from the connected account.
 */
export async function getWhatsAppContacts(
  instanceName: string,
  limit: number = 50,
): Promise<{ contacts: WhatsAppContact[]; count: number }> {
  try {
    const contactsResponse = await evolutionRequest<{ contacts: WhatsAppContact[] }>(
      `/contacts/list/${instanceName}`,
      { method: "GET" }
    );

    const contacts = contactsResponse.contacts?.slice(0, limit) || [];
    return {
      contacts,
      count: contacts.length,
    };
  } catch (error) {
    // Some Evolution versions don't support /contacts/list
    // Fallback: return empty array
    console.warn('Contacts API not available:', error);
    return { contacts: [], count: 0 };
  }
}

/**
 * Get WhatsApp instance status.
 */
export async function getWhatsAppStatus(
  instanceName: string,
): Promise<{ 
  status: 'connected' | 'disconnected' | 'error';
  instanceName: string;
  phoneNumber?: string;
  state?: string;
}> {
  try {
    const stateResponse = await fetchConnectionState(instanceName);
    const state = stateResponse.instance?.state || 'unknown';
    
    let phoneNumber: string | undefined;
    try {
      const qrResponse = await fetchQRCode(instanceName);
      phoneNumber = qrResponse.phoneNumber;
    } catch {}

    return {
      status: normalizeEvolutionState(state),
      instanceName,
      phoneNumber,
      state,
    };
  } catch (error) {
    return {
      status: 'error',
      instanceName,
    };
  }
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

// ── WhatsApp Contact & Phonebook Operations ──

/**
 * Fetch all contacts from WhatsApp (phonebook).
 */
export async function fetchWhatsAppPhonebook(
  instanceName: string,
  limit: number = 200,
): Promise<{ contacts: WhatsAppContact[]; count: number }> {
  try {
    const contactsResponse = await evolutionRequest<{ contacts: WhatsAppContact[] }>(
      `/contacts/list/${instanceName}`,
      { method: "GET" }
    );

    const contacts = contactsResponse.contacts?.slice(0, limit) || [];
    
    // Extract phone numbers and names
    const phonebook = contacts.map(contact => {
      const id = contact.id || '';
      const phoneNumber = id.split('@')[0];
      const name = contact.pushname || contact.number || phoneNumber;
      
      return {
        id: contact.id,
        phoneNumber,
        name: name,
        pushname: contact.pushname,
        verifiedName: contact.verifiedName,
        isUser: id.includes('status@broadcast') || id.includes('@s.whatsapp.net'),
      };
    });

    return {
      contacts: phonebook,
      count: phonebook.length,
    };
  } catch (error) {
    console.warn('Phonebook API not available, trying fallback:', error);
    // Fallback: try to get from connection state
    return { contacts: [], count: 0 };
  }
}

/**
 * Get instance connection details including phone number and name.
 */
export async function getInstanceDetails(
  instanceName: string,
): Promise<{
  instanceName: string;
  status: BeatriceConnectionStatus;
  phoneNumber?: string;
  phoneNumberFormatted?: string;
  accountName?: string;
  state: string;
}> {
  try {
    const stateResponse = await fetchConnectionState(instanceName);
    const state = stateResponse.instance?.state || 'unknown';
    let phoneNumber: string | undefined;
    let accountName: string | undefined;

    // Try to get phone info
    try {
      const qrResponse = await fetchQRCode(instanceName);
      phoneNumber = qrResponse.phoneNumber || qrResponse.number;
      accountName = qrResponse.accountName;
    } catch {}

    // Fallback: try to get from a different endpoint
    if (!phoneNumber) {
      try {
        const infoResponse = await evolutionRequest<{ 
          connectionState?: { state?: string };
          phoneNumber?: string;
          accountName?: string;
        }>(`/instance/info/${instanceName}`, { method: "GET" });
        phoneNumber = infoResponse.phoneNumber;
        accountName = infoResponse.accountName;
      } catch {}
    }

    return {
      instanceName,
      status: normalizeEvolutionState(state),
      phoneNumber,
      phoneNumberFormatted: phoneNumber ? formatPhoneNumber(phoneNumber) : undefined,
      accountName,
      state,
    };
  } catch (error) {
    return {
      instanceName,
      status: 'error',
      state: 'error',
    };
  }
}

/**
 * Format phone number for display.
 */
function formatPhoneNumber(phoneNumber: string): string {
  const digits = phoneNumber.replace(/\D/g, '');
  if (digits.length === 13) {
    return `+${digits.slice(0, 4)} ${digits.slice(4, 7)} ${digits.slice(7, 11)}`;
  }
  if (digits.length === 12) {
    return `+${digits.slice(0, 4)} ${digits.slice(4, 7)} ${digits.slice(7, 10)} ${digits.slice(10, 12)}`;
  }
  return `+${digits}`;
}

/**
 * Send voice message via WhatsApp (audio file).
 */
export async function sendVoiceMessage(
  instanceName: string,
  phoneNumber: string,
  audioBase64: string,
  caption?: string,
): Promise<any> {
  return evolutionRequest("/message/sendAudio/" + instanceName, {
    method: "POST",
    body: JSON.stringify({ 
      number: phoneNumber,
      audio: audioBase64,
      caption: caption || undefined,
    }),
  });
}

/**
 * Send voice note / voice memo via WhatsApp.
 */
export async function sendVoiceNote(
  instanceName: string,
  phoneNumber: string,
  audioUrl: string,
): Promise<any> {
  return evolutionRequest("/message/sendVoice/" + instanceName, {
    method: "POST",
    body: JSON.stringify({ 
      number: phoneNumber,
      audioUrl,
    }),
  });
}

/**
 * Initiate WhatsApp voice call (experimental).
 */
export async function initiateWhatsAppCall(
  instanceName: string,
  phoneNumber: string,
  callType: 'voice' | 'video' = 'voice',
): Promise<any> {
  return evolutionRequest("/call/initiateCall/" + instanceName, {
    method: "POST",
    body: JSON.stringify({ 
      number: phoneNumber,
      callType,
    }),
  });
}
