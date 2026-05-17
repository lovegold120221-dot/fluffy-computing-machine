import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { createClient } from "@supabase/supabase-js";
import admin from "firebase-admin";
import cors from "cors";
import dotenv from "dotenv";
import fs from "fs";
import { z } from "zod";
import ws from "ws";
import {
  generateWithOllama,
  getVpsStatus,
  listOllamaModels,
  runHermesAgent,
  runSubAgents,
  runTerminalCommand,
  VpsBridgeError,
} from "./lib/server/vps-bridge";
import {
  delegateTask,
  getTaskStatus,
  getActiveTasks,
} from "./lib/server/worker-engine";
import {
  createAutomation,
  getAutomations,
  getAutomation,
  updateAutomation,
  deleteAutomation,
  runAutomationNow,
  getAutomationRuns,
  loadAndScheduleAll,
} from "./lib/server/automation-engine";
import {
  createInstance,
  fetchQRCode,
  fetchConnectionState,
  sendMessage,
  logoutInstance,
  deleteInstance,
  normalizeEvolutionState,
  verifyWebhookSecret,
  searchWhatsAppMessages,
  readWhatsAppChat,
  getWhatsAppContacts,
  getWhatsAppStatus,
  fetchWhatsAppPhonebook,
  getInstanceDetails,
  sendVoiceMessage,
  initiateWhatsAppCall,
  sendVoiceNote,
} from "./lib/server/evolution-client";

dotenv.config();
dotenv.config({ path: '.env.local' });

function getBackendUrl() { return process.env.PUBLIC_BACKEND_URL || "http://localhost:3000"; }

// Initialize Firebase Admin for Authentication
if (!admin.apps.length) {
  admin.initializeApp({
    projectId: process.env.VITE_FIREBASE_PROJECT_ID || process.env.FIREBASE_PROJECT_ID,
  });
}

// Initialize Supabase Client
const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || "";

if (!supabaseUrl || !supabaseKey) {
  console.warn("WARNING: Supabase credentials missing. Settings and memories will likely fail.");
}

// Only create client if URL is present to avoid crashing on start.
const supabase = supabaseUrl ? createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
  realtime: {
    transport: ws,
  },
}) : null;

async function runMigrations() {
  if (!supabaseUrl || !supabaseKey) return;
  const migrations = [
    `ALTER TABLE user_conversations ADD COLUMN IF NOT EXISTS session_id TEXT;`,
    `ALTER TABLE user_conversations ALTER COLUMN session_id SET DEFAULT 'legacy';`,
    `ALTER TABLE user_conversations ADD COLUMN IF NOT EXISTS client_turn_id TEXT;`,
    `ALTER TABLE user_conversations ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'text';`,
    `ALTER TABLE user_conversations ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';`,
    `CREATE INDEX IF NOT EXISTS idx_user_conversations_uid_session_created_at ON user_conversations (uid, session_id, created_at ASC);`,
    `CREATE TABLE IF NOT EXISTS conversation_sessions (session_id TEXT NOT NULL, uid TEXT NOT NULL, title TEXT, summary TEXT, metadata JSONB DEFAULT '{}', started_at TIMESTAMPTZ DEFAULT now(), last_message_at TIMESTAMPTZ DEFAULT now(), created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now(), PRIMARY KEY (uid, session_id));`,
    `CREATE INDEX IF NOT EXISTS idx_conversation_sessions_uid_last_message ON conversation_sessions (uid, last_message_at DESC);`,
  ];
  for (const query of migrations) {
    try {
      const res = await fetch(`${supabaseUrl}/sql`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
        },
        body: JSON.stringify({ query }),
      });
      if (!res.ok) {
        const text = await res.text();
        console.warn(`Migration warning (${res.status}):`, text.slice(0, 200));
      }
    } catch (e: any) {
      console.warn(`Migration skipped:`, e.message);
    }
  }
}

type AuthenticatedRequest = express.Request & {
  user?: admin.auth.DecodedIdToken;
};

const jsonError = (
  res: express.Response,
  status: number,
  code: string,
  message: string,
  details?: unknown,
) => {
  return res.status(status).json({
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
    },
  });
};

const isMissingSupabaseColumn = (error: any) => {
  const message = String(error?.message || "");
  return message.includes("column") && message.includes("does not exist");
};

const normalizeRole = (role: string) => role === "assistant" ? "agent" : role;

async function refreshGoogleToken(refreshToken: string): Promise<{ access_token: string; expires_at: number } | null> {
  const clientId = process.env.GOOGLE_CLIENT_ID || process.env.VITE_FIREBASE_PROJECT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientSecret) {
    console.warn("GOOGLE_CLIENT_SECRET not set — cannot refresh Google token");
    return null;
  }

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error("Google token refresh failed:", errText);
    return null;
  }

  const data = await res.json();
  return {
    access_token: data.access_token,
    expires_at: Date.now() + (data.expires_in || 3600) * 1000,
  };
}

async function syncFirebaseUserToSupabase(user: admin.auth.DecodedIdToken) {
  if (!supabase) return;

  const now = new Date().toISOString();
  const identities = user.firebase?.identities || {};
  const providerIds = Object.keys(identities);

  const { error } = await supabase
    .from("user_profiles")
    .upsert({
      uid: user.uid,
      email: user.email || null,
      display_name: user.name || null,
      photo_url: user.picture || null,
      phone_number: user.phone_number || null,
      email_verified: Boolean(user.email_verified),
      sign_in_provider: user.firebase?.sign_in_provider || null,
      provider_ids: providerIds,
      raw_claims: {
        auth_time: user.auth_time || null,
        issuer: user.iss || null,
      },
      last_seen_at: now,
      updated_at: now,
    }, { onConflict: "uid" });

  if (error) {
    console.warn("Supabase user profile sync skipped:", error.message);
  }
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());
  app.use(cors());

  // Logging middleware
  app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
    next();
  });

  // Health check
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", message: "Server is running", supabaseConnected: !!supabase });
  });

  app.get("/api/test-whatsapp", (req, res) => {
    res.json({ route: "whatsapp-test", found: true });
  });

  // Middleware to verify Firebase Auth Token
  const authenticateToken = async (req: AuthenticatedRequest, res: express.Response, next: express.NextFunction) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      console.log("No token provided in request");
      return jsonError(res, 401, "AUTH_TOKEN_MISSING", "Unauthorized: no Firebase ID token provided.");
    }

    try {
      if (!admin.apps.length) {
         return jsonError(res, 500, "FIREBASE_ADMIN_MISSING", "Firebase Admin is not initialized.");
      }
      const decodedToken = await admin.auth().verifyIdToken(token);
      req.user = decodedToken;
      await syncFirebaseUserToSupabase(decodedToken);
      next();
    } catch (err: any) {
      console.error("Token verification error:", err.message);
      return jsonError(res, 403, "AUTH_TOKEN_INVALID", "Forbidden: invalid Firebase ID token.", err.message);
    }
  };

  const parseRequest = <T>(schema: z.ZodSchema<T>, body: unknown, res: any): T | null => {
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      res.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid request body.",
          details: parsed.error.flatten(),
        },
      });
      return null;
    }
    return parsed.data;
  };

  const sendBridgeError = (res: any, err: unknown) => {
    if (err instanceof VpsBridgeError) {
      return res.status(err.statusCode).json({
        error: {
          code: err.code,
          message: err.message,
          details: err.details,
        },
      });
    }
    const message = err instanceof Error ? err.message : String(err);
    return res.status(500).json({
      error: {
        code: "VPS_BRIDGE_ERROR",
        message,
      },
    });
  };

  const requireSupabase = (res: express.Response) => {
    if (!supabase) {
      jsonError(res, 503, "SUPABASE_NOT_CONFIGURED", "Database not connected. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
      return null;
    }
    return supabase;
  };

  const ollamaTargetSchema = z.enum(["self", "cloud"]).default("self");
  const conversationRoleSchema = z.enum(["user", "agent", "assistant", "system"]);
  const conversationSourceSchema = z.enum(["voice", "text", "tool", "system", "import"]).default("text");
  const conversationTurnSchema = z.object({
    role: conversationRoleSchema,
    content: z.string().trim().min(1).max(50000),
    session_id: z.string().trim().min(1).max(160).optional().nullable(),
    client_turn_id: z.string().trim().min(1).max(180).optional().nullable(),
    source: conversationSourceSchema.optional(),
    metadata: z.record(z.any()).optional(),
    created_at: z.string().datetime().optional(),
  });
  const conversationQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(1000).default(100),
    session_id: z.string().trim().min(1).max(160).optional(),
    q: z.string().trim().min(1).max(200).optional(),
  });
  const contextQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(200).default(60),
  });
  const memoryTypeSchema = z.enum(["personal", "work", "project", "conversation", "preference"]).default("personal");
  const memoryCreateSchema = z.object({
    content: z.string().trim().min(1).max(20000),
    type: memoryTypeSchema.optional(),
    source: z.string().trim().max(80).optional(),
    metadata: z.record(z.any()).optional(),
  });
  const vpsCommandSchema = z.object({
    command: z.string().trim().min(1).max(4000),
    cwd: z.string().trim().max(200).optional(),
    scope: z.enum(["sandbox", "system"]).default("sandbox"),
    timeoutMs: z.number().int().min(1000).max(120000).optional(),
    confirmSystem: z.boolean().optional(),
  });
  const ollamaGenerateSchema = z.object({
    target: ollamaTargetSchema,
    model: z.string().trim().min(1).max(120).optional(),
    prompt: z.string().trim().min(1).max(20000),
    system: z.string().trim().max(8000).optional(),
    timeoutMs: z.number().int().min(5000).max(180000).optional(),
  });
  const hermesRunSchema = z.object({
    prompt: z.string().trim().min(1).max(20000),
    timeoutMs: z.number().int().min(5000).max(180000).optional(),
  });
  const subAgentSchema = z.object({
    id: z.string().trim().max(60).optional(),
    name: z.string().trim().max(80).optional(),
    role: z.string().trim().max(1000).optional(),
    model: z.string().trim().max(120).optional(),
  });
  const subAgentsRunSchema = z.object({
    task: z.string().trim().min(1).max(20000),
    target: ollamaTargetSchema,
    model: z.string().trim().min(1).max(120).optional(),
    agents: z.array(subAgentSchema).max(6).optional(),
    timeoutMs: z.number().int().min(5000).max(180000).optional(),
  });

  // API Routes
  app.get("/api/supabase-check", async (req, res) => {
    try {
      if (!supabase) throw new Error("Supabase client not initialized due to missing keys.");
      const { data, error } = await supabase.from("user_settings").select("count").limit(1);
      res.json({ connected: !error, error: error ? error : null });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });
  
  // Google Token Persistence (Supabase)
  app.post("/api/google-token", authenticateToken, async (req: any, res) => {
    try {
      const { access_token, refresh_token, expires_at } = req.body || {};
      if (!access_token) return jsonError(res, 400, "MISSING_TOKEN", "access_token is required.");
      const uid = req.user?.uid;
      if (!uid) return jsonError(res, 401, "UNAUTHORIZED", "User not identified.");
      const db = requireSupabase(res);
      if (!db) return;

      try {
        await db.from("google_tokens").select("uid").limit(1);
      } catch {
        console.warn("google_tokens table not found — run GOOGLE_TOKENS_SCHEMA.sql in Supabase");
        return jsonError(res, 500, "TABLE_MISSING", "google_tokens table not found. Run GOOGLE_TOKENS_SCHEMA.sql in your Supabase SQL editor.");
      }

      const { error } = await db
        .from("google_tokens")
        .upsert({
          uid,
          access_token,
          refresh_token: refresh_token || null,
          expires_at: expires_at || null,
          updated_at: new Date().toISOString(),
        }, { onConflict: "uid" });
      if (error) {
        console.error("Supabase google_tokens upsert failed:", error.message);
        return jsonError(res, 500, "DB_ERROR", error.message);
      }
      res.json({ status: "ok" });
    } catch (err: any) {
      res.status(500).json({ error: String(err.message || err) });
    }
  });

  app.get("/api/google-token", authenticateToken, async (req: any, res) => {
    try {
      const uid = req.user?.uid;
      if (!uid) return jsonError(res, 401, "UNAUTHORIZED", "User not identified.");
      const db = requireSupabase(res);
      if (!db) return;
      const { data, error } = await db
        .from("google_tokens")
        .select("access_token, refresh_token, expires_at")
        .eq("uid", uid)
        .maybeSingle();
      if (error) return jsonError(res, 500, "DB_ERROR", error.message);
      if (!data) return jsonError(res, 404, "NOT_FOUND", "No Google token stored for this user.");

      // Auto-refresh if expired and we have a refresh token
      const now = Date.now();
      const expiresAt = data.expires_at;
      if (expiresAt && now >= expiresAt && data.refresh_token) {
        try {
          const refreshed = await refreshGoogleToken(data.refresh_token);
          if (refreshed) {
            await db.from("google_tokens").update({
              access_token: refreshed.access_token,
              expires_at: refreshed.expires_at,
              updated_at: new Date().toISOString(),
            }).eq("uid", uid);
            return res.json({ access_token: refreshed.access_token, expires_at: refreshed.expires_at });
          }
        } catch (refreshErr: any) {
          console.warn("Google token refresh failed, returning stale token:", refreshErr.message);
        }
      }

      res.json(data);
    } catch (err: any) {
      res.status(500).json({ error: String(err.message || err) });
    }
  });

  app.post("/api/google-token/refresh", authenticateToken, async (req: any, res) => {
    try {
      const uid = req.user?.uid;
      if (!uid) return jsonError(res, 401, "UNAUTHORIZED", "User not identified.");
      const db = requireSupabase(res);
      if (!db) return;

      const { data } = await db
        .from("google_tokens")
        .select("refresh_token")
        .eq("uid", uid)
        .maybeSingle();

      if (!data?.refresh_token) {
        return jsonError(res, 400, "NO_REFRESH_TOKEN", "No refresh token available. Please re-authenticate with Google.");
      }

      const refreshed = await refreshGoogleToken(data.refresh_token);
      if (!refreshed) {
        return jsonError(res, 500, "REFRESH_FAILED", "Failed to refresh Google token. Please re-authenticate.");
      }

      await db.from("google_tokens").update({
        access_token: refreshed.access_token,
        expires_at: refreshed.expires_at,
        updated_at: new Date().toISOString(),
      }).eq("uid", uid);

      res.json({ access_token: refreshed.access_token, expires_at: refreshed.expires_at });
    } catch (err: any) {
      res.status(500).json({ error: String(err.message || err) });
    }
  });

  // Settings

  // Settings
  app.get("/api/settings", authenticateToken, async (req: any, res) => {
    try {
      if (!supabase) throw new Error("Database not connected (Supabase keys missing)");
      const { uid } = req.user;
      
      // Try querying with 'uid' first
      let { data, error } = await supabase
        .from("user_settings")
        .select("*")
        .eq("uid", uid)
        .single();

      // Fallback: If 'uid' column does not exist, try using 'id' column as many auto-generated tables use 'id'
      if (error && error.message.includes('column user_settings.uid does not exist')) {
        console.warn("Fallback: 'uid' column missing in user_settings, trying 'id' column.");
        const fallback = await supabase
          .from("user_settings")
          .select("*")
          .eq("id", uid)
          .single();
        
        if (fallback.error && fallback.error.message.includes('invalid input syntax for type uuid')) {
            console.error("Critical: 'id' column is UUID type but Firebase UID is TEXT. Cannot use 'id' as fallback.");
            error = fallback.error;
        } else {
            data = fallback.data;
            error = fallback.error;
        }
      }

      if (error && error.code === 'PGRST116') {
        // No results, insert default settings. Try to guess the correct identifier column.
        const insertObj: any = { persona_name: 'Beatrice' };
        
        // Try inserting into 'uid'
        let insertResult = await supabase.from("user_settings").insert([{ uid, ...insertObj }]).select().single();
        
        // Fallback to 'id' if 'uid' missing
        if (insertResult.error && insertResult.error.message.includes('column user_settings.uid does not exist')) {
           // Only try 'id' if Firebase UID is a valid UUID or if 'id' is TEXT
           // But we don't know if 'id' is UUID. We'll try and catch.
           insertResult = await supabase.from("user_settings").insert([{ id: uid, ...insertObj }]).select().single();
           
           if (insertResult.error && insertResult.error.message.includes('invalid input syntax for type uuid')) {
                console.error("Cannot insert into 'id' because it is UUID type.");
           }
        }

        if (insertResult.error) {
          console.error("Settings INSERT error:", JSON.stringify(insertResult.error, null, 2));
          throw new Error(`Database error: ${insertResult.error.message}. Please ensure your Supabase table 'user_settings' has a 'uid' column of type TEXT.`);
        }
        return res.json(insertResult.data);
      }
      
      if (error) {
        console.error("Settings GET error details:", JSON.stringify(error, null, 2));
        if (error.message.includes('invalid input syntax for type uuid')) {
            throw new Error(`Type mismatch: Firebase UID cannot be used with a UUID column. Please ensure 'uid' is TEXT in your Supabase 'user_settings' table.`);
        }
        throw error;
      }
      res.json(data);
    } catch (err: any) {
      console.error("Settings GET catch error:", err);
      const errorMessage = err?.message || (typeof err === 'object' ? JSON.stringify(err) : String(err));
      res.status(500).json({ error: "Internal server error: " + errorMessage });
    }
  });

  app.put("/api/settings", authenticateToken, async (req: any, res) => {
    try {
      const { uid } = req.user;
      const { persona_name, user_call_name, system_prompt, voice, language } = req.body;
      
      const payload: any = {
        persona_name,
        user_call_name,
        system_prompt,
        voice,
        language
      };

      // Try to upsert with 'uid'
      let result = await supabase
        .from("user_settings")
        .upsert({ uid, ...payload })
        .select()
        .single();
      
      // Fallback if 'uid' column missing
      if (result.error && result.error.message.includes('column user_settings.uid does not exist')) {
         result = await supabase
          .from("user_settings")
          .upsert({ id: uid, ...payload })
          .select()
          .single();
          
         if (result.error && result.error.message.includes('invalid input syntax for type uuid')) {
            throw new Error(`Database schema mismatch: 'id' is a UUID column but Firebase UID is TEXT. Please run SCHEMA.sql to add a 'uid' column of type TEXT.`);
         }
      }

      // Special case: if 'language' is missing in DB but we sent it
      if (result.error && result.error.message.includes('column "language" of relation "user_settings" does not exist')) {
         console.warn("Table user_settings is missing 'language' column. Upserting without it.");
         delete payload.language;
         // Retry without language
         result = await supabase
          .from("user_settings")
          .upsert({ uid, ...payload }) 
          .select()
          .single();
          
         if (result.error && result.error.message.includes('column user_settings.uid does not exist')) {
            result = await supabase.from("user_settings").upsert({ id: uid, ...payload }).select().single();
         }
      }

      if (result.error) {
        console.error("Settings PUT error details:", JSON.stringify(result.error, null, 2));
        throw new Error(result.error.message);
      }
      res.json(result.data);
    } catch (err: any) {
      console.error("Settings PUT error:", err);
      const errorMessage = err?.message || (typeof err === 'object' ? JSON.stringify(err) : String(err));
      res.status(500).json({ error: "Internal server error: " + errorMessage });
    }
  });

  const touchConversationSession = async (uid: string, sessionId: string, title?: string | null) => {
    if (!supabase || !sessionId) return;

    const now = new Date().toISOString();
    const { error } = await supabase
      .from("conversation_sessions")
      .upsert({
        uid,
        session_id: sessionId,
        title: title || null,
        last_message_at: now,
        updated_at: now,
      }, { onConflict: "uid,session_id" });

    if (error) {
      console.warn("Conversation session sync skipped:", error.message);
    }
  };

  // Current authenticated Firebase user mirrored into Supabase.
  app.get("/api/me", authenticateToken, async (req: AuthenticatedRequest, res) => {
    try {
      const db = requireSupabase(res);
      if (!db || !req.user) return;
      const { uid } = req.user;

      const { data, error } = await db
        .from("user_profiles")
        .select("*")
        .eq("uid", uid)
        .maybeSingle();

      if (error) {
        return jsonError(res, 503, "USER_PROFILE_TABLE_MISSING", "Run SCHEMA.sql so Firebase users can be mirrored into Supabase.", error.message);
      }

      res.json({
        profile: data || {
          uid,
          email: req.user.email || null,
          display_name: req.user.name || null,
          photo_url: req.user.picture || null,
        },
      });
    } catch (err: any) {
      console.error("Fetch current user error:", err);
      jsonError(res, 500, "CURRENT_USER_FETCH_FAILED", err.message || String(err));
    }
  });

  // Long-term context assembled from the current Firebase user's Supabase rows.
  app.get("/api/conversations/context", authenticateToken, async (req: AuthenticatedRequest, res) => {
    try {
      const db = requireSupabase(res);
      if (!db || !req.user) return;
      const query = contextQuerySchema.safeParse(req.query);
      if (!query.success) {
        return jsonError(res, 400, "VALIDATION_ERROR", "Invalid context query.", query.error.flatten());
      }

      const { uid } = req.user;
      const limit = query.data.limit;

      const [profileResult, settingsResult, memoriesResult, turnsResult] = await Promise.all([
        db.from("user_profiles").select("*").eq("uid", uid).maybeSingle(),
        db.from("user_settings").select("*").eq("uid", uid).maybeSingle(),
        db.from("user_memories").select("*").eq("uid", uid).order("created_at", { ascending: false }).limit(80),
        db.from("user_conversations").select("*").eq("uid", uid).order("created_at", { ascending: false }).limit(limit),
      ]);

      const hardError = turnsResult.error || memoriesResult.error;
      if (hardError) {
        return jsonError(res, 503, "CONTEXT_TABLES_MISSING", "Run SCHEMA.sql so Supabase can store conversations and memories per Firebase UID.", hardError.message);
      }

      if (profileResult.error) console.warn("Context profile lookup skipped:", profileResult.error.message);
      if (settingsResult.error) console.warn("Context settings lookup skipped:", settingsResult.error.message);

      res.json({
        profile: profileResult.data || {
          uid,
          email: req.user.email || null,
          display_name: req.user.name || null,
          photo_url: req.user.picture || null,
        },
        settings: settingsResult.data || null,
        memories: memoriesResult.data || [],
        recentTurns: (turnsResult.data || []).reverse(),
        fetchedAt: new Date().toISOString(),
      });
    } catch (err: any) {
      console.error("Fetch conversation context error:", err);
      jsonError(res, 500, "CONTEXT_FETCH_FAILED", err.message || String(err));
    }
  });

  // Conversations (all user + AI turns, partitioned by Firebase UID)
  app.get("/api/conversations", authenticateToken, async (req: AuthenticatedRequest, res) => {
    try {
      const db = requireSupabase(res);
      if (!db || !req.user) return;
      const parsed = conversationQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return jsonError(res, 400, "VALIDATION_ERROR", "Invalid conversation query.", parsed.error.flatten());
      }

      const { uid } = req.user;
      const { limit, session_id, q } = parsed.data;

      let query = db
        .from("user_conversations")
        .select("*")
        .eq("uid", uid)
        .order("created_at", { ascending: false })
        .limit(limit);

      if (session_id) query = query.eq("session_id", session_id);
      if (q) query = query.ilike("content", `%${q}%`);

      const { data, error } = await query;

      if (error) {
        return jsonError(res, 503, "CONVERSATIONS_TABLE_MISSING", "user_conversations is unavailable. Run SCHEMA.sql in Supabase.", error.message);
      }

      res.json((data || []).reverse());
    } catch (err: any) {
      console.error("Fetch conversations error:", err);
      jsonError(res, 500, "CONVERSATIONS_FETCH_FAILED", err.message || String(err));
    }
  });

  app.post("/api/conversations", authenticateToken, async (req: AuthenticatedRequest, res) => {
    const body = parseRequest(conversationTurnSchema, req.body, res);
    if (!body || !req.user) return;

    try {
      const db = requireSupabase(res);
      if (!db) return;

      const uid = req.user.uid;
      const sessionId = body.session_id || `default-${uid}`;
      const createdAt = body.created_at || new Date().toISOString();
      const content = body.content.trim();
      const title = content.length > 90 ? `${content.slice(0, 90)}...` : content;

      await touchConversationSession(uid, sessionId, title);

      const fullPayload: Record<string, unknown> = {
        uid,
        session_id: sessionId,
        role: normalizeRole(body.role),
        content,
        client_turn_id: body.client_turn_id || null,
        source: body.source || "text",
        metadata: body.metadata || {},
        created_at: createdAt,
      };

      let result = await db
        .from("user_conversations")
        .insert(fullPayload)
        .select()
        .single();

      if (result.error?.code === "23505" && body.client_turn_id) {
        result = await db
          .from("user_conversations")
          .select("*")
          .eq("uid", uid)
          .eq("client_turn_id", body.client_turn_id)
          .maybeSingle();
      }

      if (result.error && isMissingSupabaseColumn(result.error)) {
        const fallbackPayload = {
          uid,
          session_id: sessionId,
          role: normalizeRole(body.role),
          content,
          created_at: createdAt,
        };
        result = await db
          .from("user_conversations")
          .insert(fallbackPayload)
          .select()
          .single();
      }

      if (result.error) {
        return jsonError(res, 500, "CONVERSATION_SAVE_FAILED", result.error.message, result.error);
      }

      res.json(result.data);
    } catch (err: any) {
      console.error("Save conversation turn error:", err);
      jsonError(res, 500, "CONVERSATION_SAVE_FAILED", err.message || String(err));
    }
  });

  // Memories
  app.get("/api/memories", authenticateToken, async (req: AuthenticatedRequest, res) => {
    try {
      const db = requireSupabase(res);
      if (!db || !req.user) return;
      const { uid } = req.user;
      const { data, error } = await db
        .from("user_memories")
        .select("*")
        .eq("uid", uid)
        .order("created_at", { ascending: false });

      if (error) {
        return jsonError(res, 503, "MEMORIES_TABLE_MISSING", "user_memories is unavailable. Run SCHEMA.sql in Supabase.", error.message);
      }
      res.json(data || []);
    } catch (err: any) {
      console.error("Memories GET error:", err);
      jsonError(res, 500, "MEMORIES_FETCH_FAILED", err.message || String(err));
    }
  });

  app.post("/api/memories", authenticateToken, async (req: AuthenticatedRequest, res) => {
    const body = parseRequest(memoryCreateSchema, req.body, res);
    if (!body || !req.user) return;

    try {
      const db = requireSupabase(res);
      if (!db) return;
      const { uid } = req.user;

      let result = await db
        .from("user_memories")
        .insert([{
          uid,
          content: body.content.trim(),
          type: body.type || "personal",
          source: body.source || "manual",
          metadata: body.metadata || {},
        }])
        .select()
        .single();

      if (result.error && isMissingSupabaseColumn(result.error)) {
        result = await db
          .from("user_memories")
          .insert([{ uid, content: body.content.trim(), type: body.type || "personal" }])
          .select()
          .single();
      }

      if (result.error) {
        return jsonError(res, 500, "MEMORY_SAVE_FAILED", result.error.message, result.error);
      }

      res.json(result.data);
    } catch (err: any) {
      console.error("Memories POST error:", err);
      jsonError(res, 500, "MEMORY_SAVE_FAILED", err.message || String(err));
    }
  });

  app.delete("/api/memories/:id", authenticateToken, async (req: AuthenticatedRequest, res) => {
    try {
      const db = requireSupabase(res);
      if (!db || !req.user) return;
      const { uid } = req.user;
      const { id } = req.params;

      const { error } = await db
        .from("user_memories")
        .delete()
        .eq("id", id)
        .eq("uid", uid);

      if (error) {
        return jsonError(res, 500, "MEMORY_DELETE_FAILED", error.message, error);
      }
      res.json({ status: "success" });
    } catch (err: any) {
      console.error("Memories DELETE error:", err);
      jsonError(res, 500, "MEMORY_DELETE_FAILED", err.message || String(err));
    }
  });

  // Storage Example Endpoint (if user wants to upload something)
  app.post("/api/upload", authenticateToken, async (req: any, res) => {
     // This is a placeholder for future storage implementation if needed
     res.status(501).json({ error: "Storage endpoint not fully implemented. Requires multipart/form-data handling." });
  });

  // VPS / Ollama / Hermes bridge
  app.get("/api/vps/status", authenticateToken, async (req: any, res) => {
    try {
      res.json(await getVpsStatus());
    } catch (err) {
      sendBridgeError(res, err);
    }
  });

  app.get("/api/vps/ollama/models", authenticateToken, async (req: any, res) => {
    try {
      const target = ollamaTargetSchema.parse(req.query.target || "self");
      res.json(await listOllamaModels(target));
    } catch (err) {
      sendBridgeError(res, err);
    }
  });

  app.post("/api/vps/ollama/generate", authenticateToken, async (req: any, res) => {
    const body = parseRequest(ollamaGenerateSchema, req.body, res);
    if (!body) return;

    try {
      res.json(await generateWithOllama(body));
    } catch (err) {
      sendBridgeError(res, err);
    }
  });

  app.post("/api/vps/terminal", authenticateToken, async (req: any, res) => {
    const body = parseRequest(vpsCommandSchema, req.body, res);
    if (!body) return;

    try {
      res.json(await runTerminalCommand(body));
    } catch (err) {
      sendBridgeError(res, err);
    }
  });

  app.post("/api/vps/hermes/run", authenticateToken, async (req: any, res) => {
    const body = parseRequest(hermesRunSchema, req.body, res);
    if (!body) return;

    try {
      res.json(await runHermesAgent(body));
    } catch (err) {
      sendBridgeError(res, err);
    }
  });

  app.post("/api/vps/subagents/run", authenticateToken, async (req: any, res) => {
    const body = parseRequest(subAgentsRunSchema, req.body, res);
    if (!body) return;

    try {
      res.json(await runSubAgents(body));
    } catch (err) {
      sendBridgeError(res, err);
    }
  });

  // Background worker task delegation
  const delegateTaskSchema = z.object({
    description: z.string().min(1).max(500),
    type: z.enum(["terminal", "ollama", "hermes", "subagents"]),
    params: z.record(z.any()),
    timeoutMs: z.number().optional(),
  });

  app.post("/api/tasks/delegate", authenticateToken, async (req: any, res) => {
    const body = parseRequest(delegateTaskSchema, req.body, res);
    if (!body) return;

    try {
      const result = await delegateTask(body);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get("/api/tasks/status/:taskId", authenticateToken, async (req: any, res) => {
    try {
      const task = getTaskStatus(req.params.taskId);
      if (!task) return res.status(404).json({ error: "Task not found" });
      res.json(task);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get("/api/tasks/active", authenticateToken, async (req: any, res) => {
    try {
      res.json(getActiveTasks());
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Automation CRUD routes
  const createAutomationSchema = z.object({
    title: z.string().min(1).max(200),
    description: z.string().min(1),
    schedule: z.object({
      type: z.enum(["once", "daily", "weekly", "monthly"]),
      time: z.string().optional(),
      timezone: z.string().optional(),
    }),
    agent: z.string().optional(),
    input: z.record(z.any()).optional(),
    output: z.record(z.any()).optional(),
  });

  const updateAutomationSchema = z.object({
    title: z.string().min(1).max(200).optional(),
    description: z.string().min(1).optional(),
    schedule: z.object({
      type: z.enum(["once", "daily", "weekly", "monthly"]),
      time: z.string().optional(),
      timezone: z.string().optional(),
    }).optional(),
    status: z.enum(["active", "paused"]).optional(),
    input: z.record(z.any()).optional(),
    output: z.record(z.any()).optional(),
  });

  app.post("/api/automations", authenticateToken, async (req: any, res) => {
    const body = parseRequest(createAutomationSchema, req.body, res);
    if (!body) return;
    try {
      const result = await createAutomation({ uid: req.user.uid, ...body });
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  app.get("/api/automations", authenticateToken, async (req: any, res) => {
    try {
      const result = await getAutomations(req.user.uid);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  app.get("/api/automations/:id", authenticateToken, async (req: any, res) => {
    try {
      const result = await getAutomation(req.params.id, req.user.uid);
      if (!result) return res.status(404).json({ error: "Not found" });
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  app.patch("/api/automations/:id", authenticateToken, async (req: any, res) => {
    const body = parseRequest(updateAutomationSchema, req.body, res);
    if (!body) return;
    try {
      const result = await updateAutomation(req.params.id, req.user.uid, body);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  app.delete("/api/automations/:id", authenticateToken, async (req: any, res) => {
    try {
      await deleteAutomation(req.params.id, req.user.uid);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  app.post("/api/automations/:id/run", authenticateToken, async (req: any, res) => {
    try {
      const result = await runAutomationNow(req.params.id, req.user.uid);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  app.get("/api/automations/:id/runs", authenticateToken, async (req: any, res) => {
    try {
      const result = await getAutomationRuns(req.params.id, req.user.uid);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  // ── WhatsApp Integration Routes ──

  app.post("/api/whatsapp/connect", authenticateToken, async (req: any, res) => {
    try {
      const uid = req.user?.uid;
      if (!uid) return jsonError(res, 401, "UNAUTHORIZED", "User not identified.");
      const db = requireSupabase(res);
      if (!db) return;

      const instanceName = `beatrice_user_${uid}`;
      const webhookUrl = `${getBackendUrl()}/webhooks/evolution`;

      // Check existing connection
      const { data: existing } = await db
        .from("whatsapp_connections")
        .select("*")
        .eq("user_id", uid)
        .maybeSingle();

      if (existing?.status === "connected") {
        return res.json({
          status: "connected",
          instanceName: existing.instance_name,
          phoneNumber: existing.phone_number,
        });
      }

      // Create Evolution instance
      let instanceCreated = false;
      try {
        await createInstance(instanceName, webhookUrl);
        instanceCreated = true;
      } catch (err: any) {
        const msg = String(err.message);
        if (msg.includes("already in use")) {
          instanceCreated = true; // instance exists, proceed
        } else {
          console.error("Evolution createInstance failed:", msg);
          return jsonError(res, 500, "EVOLUTION_ERROR", "Failed to create WhatsApp instance: " + msg);
        }
      }

      // Small delay to let instance initialize
      if (instanceCreated) {
        await new Promise(r => setTimeout(r, 1500));
      }

      // Fetch QR code
      let qrBase64: string | undefined;
      let pairingCode: string | undefined;
      try {
        const qr = await fetchQRCode(instanceName);
        qrBase64 = qr.base64;
        pairingCode = qr.pairingCode;
      } catch (err: any) {
        console.error("Evolution fetchQRCode failed:", err.message);
        return jsonError(res, 500, "EVOLUTION_ERROR", "Failed to fetch WhatsApp QR: " + err.message);
      }

      if (!qrBase64) {
        return jsonError(res, 500, "EVOLUTION_ERROR", "No QR code returned from Evolution API.");
      }

      // Upsert connection record
      const { error: upsertErr } = await db
        .from("whatsapp_connections")
        .upsert({
          user_id: uid,
          instance_name: instanceName,
          status: "connecting",
          qr_base64: qrBase64,
          pairing_code: pairingCode || null,
          updated_at: new Date().toISOString(),
        }, { onConflict: "user_id" });

      if (upsertErr) {
        console.error("whatsapp_connections upsert:", upsertErr.message);
        return jsonError(res, 500, "DB_ERROR", upsertErr.message);
      }

      res.json({
        status: "connecting",
        instanceName,
        qrBase64: qrBase64,
        pairingCode: pairingCode || null,
      });
    } catch (err: any) {
      console.error("POST /api/whatsapp/connect:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/whatsapp/status", authenticateToken, async (req: any, res) => {
    try {
      const uid = req.user?.uid;
      if (!uid) return jsonError(res, 401, "UNAUTHORIZED", "User not identified.");
      const db = requireSupabase(res);
      if (!db) return;

      const { data: conn } = await db
        .from("whatsapp_connections")
        .select("*")
        .eq("user_id", uid)
        .maybeSingle();

      if (!conn) {
        return res.json({ status: "not_connected", instanceName: null });
      }

      // Check live connection state from Evolution
      try {
        const state = await fetchConnectionState(conn.instance_name);
        const normalized = normalizeEvolutionState(state.instance?.state || "close");

        // Update DB if status changed
        if (normalized !== conn.status) {
          await db.from("whatsapp_connections")
            .update({ status: normalized, updated_at: new Date().toISOString() })
            .eq("user_id", uid);
        }

        res.json({
          status: normalized,
          instanceName: conn.instance_name,
          phoneNumber: conn.phone_number || null,
          qrBase64: conn.qr_base64 || null,
        });
      } catch (err: any) {
        // Evolution unreachable — return cached status
        res.json({
          status: conn.status,
          instanceName: conn.instance_name,
          phoneNumber: conn.phone_number || null,
          qrBase64: conn.qr_base64 || null,
        });
      }
    } catch (err: any) {
      console.error("GET /api/whatsapp/status:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/whatsapp/send", authenticateToken, async (req: any, res) => {
    try {
      const uid = req.user?.uid;
      if (!uid) return jsonError(res, 401, "UNAUTHORIZED", "User not identified.");
      const { number, text } = req.body || {};
      if (!number || !text) {
        return jsonError(res, 400, "MISSING_FIELDS", "number and text are required.");
      }

      const db = requireSupabase(res);
      if (!db) return;

      const { data: conn } = await db
        .from("whatsapp_connections")
        .select("*")
        .eq("user_id", uid)
        .eq("status", "connected")
        .maybeSingle();

      if (!conn) {
        return jsonError(res, 400, "NOT_CONNECTED", "WhatsApp is not connected.");
      }

      const result = await sendMessage(conn.instance_name, number, text);
      res.json({ status: "sent", result });
    } catch (err: any) {
      console.error("POST /api/whatsapp/send:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/whatsapp/disconnect", authenticateToken, async (req: any, res) => {
    try {
      const uid = req.user?.uid;
      if (!uid) return jsonError(res, 401, "UNAUTHORIZED", "User not identified.");
      const db = requireSupabase(res);
      if (!db) return;

      const { data: conn } = await db
        .from("whatsapp_connections")
        .select("*")
        .eq("user_id", uid)
        .maybeSingle();

      if (!conn) {
        return res.json({ status: "not_connected" });
      }

      // Logout + delete instance from Evolution
      try { await logoutInstance(conn.instance_name); } catch (e) {}
      try { await deleteInstance(conn.instance_name); } catch (e) {}

      // Update DB
      await db.from("whatsapp_connections")
        .update({ status: "disconnected", updated_at: new Date().toISOString() })
        .eq("user_id", uid);

      res.json({ status: "disconnected" });
    } catch (err: any) {
      console.error("POST /api/whatsapp/disconnect:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ── WhatsApp Tool API Handlers ──
  app.post("/api/whatsapp/search", authenticateToken, async (req: any, res) => {
    try {
      const uid = req.user?.uid;
      if (!uid) return jsonError(res, 401, "UNAUTHORIZED", "User not identified.");
      const db = requireSupabase(res);
      if (!db) return;

      const { data: conn } = await db
        .from("whatsapp_connections")
        .select("instance_name")
        .eq("user_id", uid)
        .maybeSingle();

      if (!conn) {
        return jsonError(res, 400, "NOT_CONNECTED", "WhatsApp is not connected.");
      }

      const { phoneNumber, query, limit = 20 } = req.body;
      if (!phoneNumber) {
        return jsonError(res, 400, "MISSING_PHONE_NUMBER", "Phone number required.");
      }

      const result = await searchWhatsAppMessages(conn.instance_name, phoneNumber, query, limit);
      res.json({ success: true, ...result, instanceName: conn.instance_name });
    } catch (err: any) {
      console.error("POST /api/whatsapp/search:", err.message);
      jsonError(res, 500, "WHATSAPP_SEARCH_ERROR", err.message);
    }
  });

  app.post("/api/whatsapp/read", authenticateToken, async (req: any, res) => {
    try {
      const uid = req.user?.uid;
      if (!uid) return jsonError(res, 401, "UNAUTHORIZED", "User not identified.");
      const db = requireSupabase(res);
      if (!db) return;

      const { data: conn } = await db
        .from("whatsapp_connections")
        .select("instance_name")
        .eq("user_id", uid)
        .maybeSingle();

      if (!conn) {
        return jsonError(res, 400, "NOT_CONNECTED", "WhatsApp is not connected.");
      }

      const { phoneNumber, limit = 30 } = req.body;
      if (!phoneNumber) {
        return jsonError(res, 400, "MISSING_PHONE_NUMBER", "Phone number required.");
      }

      const result = await readWhatsAppChat(conn.instance_name, phoneNumber, limit);
      res.json({ success: true, ...result, instanceName: conn.instance_name });
    } catch (err: any) {
      console.error("POST /api/whatsapp/read:", err.message);
      jsonError(res, 500, "WHATSAPP_READ_ERROR", err.message);
    }
  });

  app.post("/api/whatsapp/instance-status", authenticateToken, async (req: any, res) => {
    try {
      const uid = req.user?.uid;
      if (!uid) return jsonError(res, 401, "UNAUTHORIZED", "User not identified.");
      const db = requireSupabase(res);
      if (!db) return;

      const { data: conn } = await db
        .from("whatsapp_connections")
        .select("instance_name")
        .eq("user_id", uid)
        .maybeSingle();

      if (!conn) {
        return res.json({ success: true, connected: false, instanceName: null });
      }

      const details = await getInstanceDetails(conn.instance_name);
      res.json({ success: true, ...details });
    } catch (err: any) {
      console.error("POST /api/whatsapp/instance-status:", err.message);
      jsonError(res, 500, "WHATSAPP_STATUS_ERROR", err.message);
    }
  });

  app.post("/api/whatsapp/contacts", authenticateToken, async (req: any, res) => {
    try {
      const uid = req.user?.uid;
      if (!uid) return jsonError(res, 401, "UNAUTHORIZED", "User not identified.");
      const db = requireSupabase(res);
      if (!db) return;

      const { data: conn } = await db
        .from("whatsapp_connections")
        .select("instance_name")
        .eq("user_id", uid)
        .maybeSingle();

      if (!conn) {
        return jsonError(res, 400, "NOT_CONNECTED", "WhatsApp is not connected.");
      }

      const { limit = 50 } = req.body;
      const result = await getWhatsAppContacts(conn.instance_name, limit);
      res.json({ success: true, ...result, instanceName: conn.instance_name });
    } catch (err: any) {
      console.error("POST /api/whatsapp/contacts:", err.message);
      jsonError(res, 500, "WHATSAPP_CONTACTS_ERROR", err.message);
    }
  });

  // ── WhatsApp Activity Logging ──
  app.post("/api/whatsapp/activities", authenticateToken, async (req: any, res) => {
    try {
      const uid = req.user?.uid;
      if (!uid) return jsonError(res, 401, "UNAUTHORIZED", "User not identified.");

      const { limit = 50, type, direction } = req.body;

      let query = supabase?.from("whatsapp_activities").select("*").eq("user_id", uid);
      if (type) query = query?.eq("activity_type", type);
      if (direction) query = query?.eq("direction", direction);
      query = query?.order("created_at", { ascending: false }).limit(limit);

      const { data, error } = await query || { data: [], error: null };

      if (error && !String(error).includes("does not exist")) {
        console.error("Get activities error:", error);
      }

      res.json({
        success: true,
        activities: data || [],
        count: (data || []).length,
      });
    } catch (err: any) {
      console.error("POST /api/whatsapp/activities:", err.message);
      jsonError(res, 500, "ACTIVITIES_ERROR", err.message);
    }
  });

  // ── WhatsApp Phonebook (GET) ──
  app.get("/api/whatsapp/phonebook", authenticateToken, async (req: any, res) => {
    try {
      const uid = req.user?.uid;
      if (!uid) return jsonError(res, 401, "UNAUTHORIZED", "User not identified.");
      
      const db = requireSupabase(res);
      if (!db) return;

      const { data: conn } = await db
        .from("whatsapp_connections")
        .select("instance_name")
        .eq("user_id", uid)
        .maybeSingle();

      if (!conn || !conn.instance_name) {
        return res.json({
          success: true,
          contacts: [],
          count: 0,
          instanceName: null,
        });
      }

      const result = await fetchWhatsAppPhonebook(conn.instance_name, 200);
      
      // Log this as a Gemini Live audio action
      if (supabase) {
        await supabase.from("whatsapp_activities").insert({
          user_id: uid,
          instance_name: conn.instance_name,
          activity_type: "get_phonebook",
          direction: "inbound",
          status: "success",
          source: "gemini_live_audio",
          created_at: new Date().toISOString(),
        });
      }

      res.json({
        success: true,
        ...result,
        instanceName: conn.instance_name,
      });
    } catch (err: any) {
      console.error("GET /api/whatsapp/phonebook:", err.message);
      jsonError(res, 500, "PHONEBOOK_ERROR", err.message);
    }
  });

  // ── Cartesia Voice Generation ──
  app.post("/api/cartesia/generate-voice", authenticateToken, async (req: any, res) => {
    try {
      const uid = req.user?.uid;
      if (!uid) return jsonError(res, 401, "UNAUTHORIZED", "User not identified.");

      const { text, voiceId, language, emotion, speed, volume } = req.body;

      if (!text) {
        return jsonError(res, 400, "MISSING_TEXT", "Text required for voice generation.");
      }

      const cartesiaApiKey = process.env.CARTESIA_API_KEY;
      if (!cartesiaApiKey) {
        return jsonError(res, 500, "CARTESIA_NOT_CONFIGURED", "Cartesia API key not configured.");
      }

      const usedVoiceId = voiceId || process.env.CARTESIA_VOICE_ID || "8f1b2cc5-af0c-4567-a2c2-bf0f1dc49220";
      const usedLanguage = language || "en";
      const usedEmotion = emotion || "content";
      const usedSpeed = speed ?? 1;
      const usedVolume = volume ?? 1;

      const response = await fetch("https://api.cartesia.ai/tts/bytes", {
        method: "POST",
        headers: {
          "Cartesia-Version": "2026-03-01",
          "X-API-Key": cartesiaApiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model_id: "sonic-3.5",
          transcript: text,
          voice: {
            mode: "id",
            id: usedVoiceId,
          },
          output_format: {
            container: "wav",
            encoding: "pcm_s16le",
            sample_rate: 44100,
          },
          language: usedLanguage,
          generation_config: {
            speed: usedSpeed,
            volume: usedVolume,
            emotion: usedEmotion,
          },
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        return jsonError(res, 500, "CARTESIA_ERROR", errText);
      }

      const audioBuffer = await response.arrayBuffer();
      const base64Audio = Buffer.from(audioBuffer).toString("base64");

      if (supabase) {
        await supabase.from("whatsapp_activities").insert({
          user_id: uid,
          activity_type: "generate_voice",
          direction: "outbound",
          content: text,
          status: "success",
          source: "gemini_live_audio",
          metadata: { voiceId: usedVoiceId, language: usedLanguage, emotion: usedEmotion, model: "sonic-3.5" },
          created_at: new Date().toISOString(),
        });
      }

      res.json({
        success: true,
        audioBase64: base64Audio,
        voiceId: usedVoiceId,
        format: "wav",
        sampleRate: 44100,
        encoding: "pcm_s16le",
      });
    } catch (err: any) {
      console.error("POST /api/cartesia/generate-voice:", err.message);
      jsonError(res, 500, "VOICE_GENERATION_ERROR", err.message);
    }
  });

  // ── WhatsApp Voice Message & Call Routes ──
  app.post("/api/whatsapp/send-voice", authenticateToken, async (req: any, res) => {
    try {
      const uid = req.user?.uid;
      if (!uid) return jsonError(res, 401, "UNAUTHORIZED", "User not identified.");
      const db = requireSupabase(res);
      if (!db) return;

      const { data: conn } = await db
        .from("whatsapp_connections")
        .select("instance_name")
        .eq("user_id", uid)
        .eq("status", "connected")
        .maybeSingle();

      if (!conn) {
        return jsonError(res, 400, "NOT_CONNECTED", "WhatsApp is not connected.");
      }

      const { phoneNumber, audioBase64, caption } = req.body;
      if (!phoneNumber || !audioBase64) {
        return jsonError(res, 400, "MISSING_PARAMETERS", "Phone number and audio required.");
      }

      const result = await sendVoiceMessage(conn.instance_name, phoneNumber, audioBase64, caption);

      await supabase.from("whatsapp_activities").insert({
        user_id: uid,
        instance_name: conn.instance_name,
        activity_type: "send_voice_message",
        direction: "outbound",
        phone_number: phoneNumber,
        content: caption || "Voice message",
        status: "sent",
        source: "gemini_live_audio",
        created_at: new Date().toISOString(),
      });

      res.json(result);
    } catch (err: any) {
      console.error("POST /api/whatsapp/send-voice:", err.message);
      jsonError(res, 500, "VOICE_SEND_ERROR", err.message);
    }
  });

  app.post("/api/whatsapp/initiate-call", authenticateToken, async (req: any, res) => {
    try {
      const uid = req.user?.uid;
      if (!uid) return jsonError(res, 401, "UNAUTHORIZED", "User not identified.");
      const db = requireSupabase(res);
      if (!db) return;

      const { data: conn } = await db
        .from("whatsapp_connections")
        .select("instance_name")
        .eq("user_id", uid)
        .eq("status", "connected")
        .maybeSingle();

      if (!conn) {
        return jsonError(res, 400, "NOT_CONNECTED", "WhatsApp is not connected.");
      }

      const { phoneNumber, callType = 'voice' } = req.body;
      if (!phoneNumber) {
        return jsonError(res, 400, "MISSING_PHONE_NUMBER", "Phone number required.");
      }

      const result = await initiateWhatsAppCall(conn.instance_name, phoneNumber, callType);

      await supabase.from("whatsapp_activities").insert({
        user_id: uid,
        instance_name: conn.instance_name,
        activity_type: `initiate_${callType}_call`,
        direction: "outbound",
        phone_number: phoneNumber,
        status: "initiated",
        source: "gemini_live_audio",
        metadata: { callType },
        created_at: new Date().toISOString(),
      });

      res.json(result);
    } catch (err: any) {
      console.error("POST /api/whatsapp/initiate-call:", err.message);
      jsonError(res, 500, "CALL_INITIATE_ERROR", err.message);
    }
  });

  //
  // Run database migrations on startup
  await runMigrations();

  //
  // Load scheduled automations on startup
  loadAndScheduleAll();

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('{*path}', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  // Error handling middleware
  app.use((err: any, req: any, res: any, next: any) => {
    console.error("GLOBAL ERROR HANDLER:", err);
    res.status(500).json({ error: "Internal Server Error", details: err.message || String(err) });
  });

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Supabase integrated for DB storage.`);
  });
}

startServer();
