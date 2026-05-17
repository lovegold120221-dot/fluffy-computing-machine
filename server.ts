import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { createClient } from "@supabase/supabase-js";
import admin from "firebase-admin";
import cors from "cors";
import dotenv from "dotenv";
import fs from "fs";
import { z } from "zod";
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

dotenv.config();
dotenv.config({ path: '.env.local' });

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

// Only create client if URL is present to avoid crashing on start
const supabase = supabaseUrl ? createClient(supabaseUrl, supabaseKey) : null;

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

  // Middleware to verify Firebase Auth Token
  const authenticateToken = async (req: any, res: any, next: any) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      console.log("No token provided in request");
      return res.status(401).json({ error: "Unauthorized: No token provided" });
    }

    try {
      if (!admin.apps.length) {
         return res.status(500).json({ error: "Firebase Admin not initialized" });
      }
      const decodedToken = await admin.auth().verifyIdToken(token);
      req.user = decodedToken;
      next();
    } catch (err: any) {
      console.error("Token verification error:", err.message);
      return res.status(403).json({ error: "Forbidden: Invalid token", details: err.message });
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

  const ollamaTargetSchema = z.enum(["self", "cloud"]).default("self");
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

  // Conversations
  app.get("/api/conversations", authenticateToken, async (req: any, res) => {
    try {
      if (!supabase) throw new Error("Database not connected (Supabase keys missing)");
      const { uid } = req.user;
      const { limit = 100 } = req.query;
      
      const { data, error } = await supabase
        .from("user_conversations")
        .select("*")
        .eq("uid", uid)
        .order("created_at", { ascending: false })
        .limit(Number(limit));

      if (error) {
        if (error.code === 'PGRST116' || error.message.includes('cache')) {
          return res.status(503).json({ 
            error: "Conversation database table is missing. Please run the SQL in SCHEMA.sql in your Supabase SQL Editor to enable history.",
            setupRequired: true
          });
        }
        throw error;
      }
      res.json(data ? data.reverse() : []);
    } catch (err: any) {
      console.error("Fetch conversations error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/conversations", authenticateToken, async (req: any, res) => {
    try {
      if (!supabase) throw new Error("Database not connected (Supabase keys missing)");
      const { uid } = req.user;
      const { role, content, session_id } = req.body;

      if (!role || !content) {
        return res.status(400).json({ error: "Missing role or content" });
      }

      const { data, error } = await supabase
        .from("user_conversations")
        .insert({
          uid,
          role,
          content,
          session_id
        })
        .select()
        .single();

      if (error) {
        if (error.code === 'PGRST116' || error.message.includes('cache')) {
          console.warn("Skipping conversation sync: table missing.");
          return res.status(204).send(); // Silently fail for inserts if table missing
        }
        throw error;
      }
      res.json(data);
    } catch (err: any) {
      console.error("Save conversation turn error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // Memories
  app.get("/api/memories", authenticateToken, async (req: any, res) => {
    try {
      if (!supabase) throw new Error("Database not connected (Supabase keys missing)");
      const { uid } = req.user;
      let { data, error } = await supabase
        .from("user_memories")
        .select("*")
        .eq("uid", uid)
        .order("created_at", { ascending: false });

      // Fallback if 'uid' column missing
      if (error && error.message.includes('column user_memories.uid does not exist')) {
        console.warn("Fallback: 'uid' column missing in user_memories. Cannot safely fallback to 'id' (BIGINT/UUID).");
      }

      if (error) {
          if (error.message.includes('invalid input syntax for type uuid')) {
              throw new Error(`Type mismatch in user_memories: Firebase UID cannot be used with a UUID column.`);
          }
          throw error;
      }
      res.json(data);
    } catch (err: any) {
      console.error("Memories GET error:", err);
      const errorMessage = err?.message || (typeof err === 'object' ? JSON.stringify(err) : String(err));
      res.status(500).json({ error: "Internal server error: " + errorMessage });
    }
  });

  app.post("/api/memories", authenticateToken, async (req: any, res) => {
    try {
      if (!supabase) throw new Error("Database not connected (Supabase keys missing)");
      const { uid } = req.user;
      const { content, type = 'personal' } = req.body;

      if (!content) {
        return res.status(400).json({ error: "Missing 'content' in request body" });
      }
      
      console.log(`Saving memory for ${uid}:`, { content, type });

      let result = await supabase
        .from("user_memories")
        .insert([{ uid, content, type }])
        .select()
        .single();

      // Fallback if 'uid' column missing
      if (result.error && result.error.message.includes('column user_memories.uid does not exist')) {
         console.error("Critical: user_memories table is missing 'uid' column. Please run SCHEMA.sql.");
         return res.status(500).json({ error: "Database schema mismatch: missing 'uid' column in user_memories table." });
      }

      if (result.error) {
          console.error("Memories POST Supabase error:", result.error);
          if (result.error.message.includes('invalid input syntax for type uuid')) {
              return res.status(400).json({ error: `Type mismatch in user_memories: Cannot insert into a UUID column with Firebase UID TEXT. Please run SCHEMA.sql.` });
          }
          return res.status(500).json({ error: result.error.message });
      }
      res.json(result.data);
    } catch (err: any) {
      console.error("Memories POST catch error:", err);
      const errorMessage = err?.message || String(err);
      res.status(500).json({ error: "Internal server error: " + errorMessage });
    }
  });

  app.delete("/api/memories/:id", authenticateToken, async (req: any, res) => {
    try {
      if (!supabase) throw new Error("Database not connected (Supabase keys missing)");
      const { uid } = req.user;
      const { id } = req.params;
      
      let { error } = await supabase
        .from("user_memories")
        .delete()
        .eq("id", id) // 'id' here is the memory's BIGINT id
        .eq("uid", uid);

      // Fallback if 'uid' column missing
      if (error && error.message.includes('column user_memories.uid does not exist')) {
         // Note: in many tables, if they don't have 'uid', they might NOT have a way to filter by user
         // unless 'id' is also the user id (but for memories it's likely a primary key).
         // However, we'll try to find if there is another column or just report error.
         // Actually, if uid is missing in memories, it's a structural problem.
         // We'll try one fallback to 'userId' or just show error.
         console.error("Critical: user_memories is missing 'uid' column.");
      }

      if (error) throw error;
      res.json({ status: "success" });
    } catch (err: any) {
      console.error("Memories DELETE error:", err);
      const errorMessage = err?.message || (typeof err === 'object' ? JSON.stringify(err) : String(err));
      res.status(500).json({ error: "Internal server error: " + errorMessage });
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
    app.get('*', (req, res) => {
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
