import cron from "node-cron";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";
import { runHermesAgent } from "./vps-bridge";

const supabaseUrl = process.env.SUPABASE_URL || "";
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const supabase = supabaseUrl ? createClient(supabaseUrl, supabaseKey) : null;

function getSupabase() {
  if (!supabase) throw new Error("Supabase not configured");
  return supabase;
}

const scheduledJobs = new Map<string, cron.ScheduledTask>();

export function buildHermesWorkflowPrompt(input: {
  title: string;
  description: string;
  scheduleType: string;
  time?: string;
  outputFormat?: string;
}): string {
  const scheduleDesc =
    input.scheduleType === "once"
      ? "Run once now."
      : input.scheduleType === "daily"
        ? `Run daily at ${input.time || "08:00"}.`
        : input.scheduleType === "weekly"
          ? `Run weekly on Monday at ${input.time || "08:00"}.`
          : `Run monthly on the 1st at ${input.time || "08:00"}.`;

  return [
    `You are Hermes Automation Agent.`,
    ``,
    `Task: ${input.title}`,
    `${input.description}`,
    ``,
    `Schedule: ${scheduleDesc}`,
    ``,
    `Output format: ${input.outputFormat || "summary"}`,
    ``,
    `Instructions:`,
    `1. Analyze the available data and produce the requested output.`,
    `2. If required data sources are unavailable, note what is missing and produce a partial report.`,
    `3. Return structured output with these sections:`,
    `   - Executive summary (2-3 sentences)`,
    `   - Key metrics / findings`,
    `   - Action items or recommendations`,
    `   - Short spoken summary for Beatrice (1-2 sentences, conversational)`,
    `4. Do NOT chat casually. Return structured automation output.`,
    `5. Be concise. Prioritize actionable information.`,
  ].join("\n");
}

export async function createAutomation(input: {
  uid: string;
  title: string;
  description: string;
  schedule: { type: string; time?: string; timezone?: string };
  agent?: string;
  input?: Record<string, any>;
  output?: Record<string, any>;
}) {
  const db = getSupabase();
  const now = new Date();
  const nextRunAt = computeNextRun(input.schedule.type, input.schedule.time);

  const { data, error } = await db
    .from("automations")
    .insert({
      uid: input.uid,
      title: input.title,
      description: input.description,
      agent: input.agent || "hermes",
      schedule: input.schedule,
      input: input.input || {},
      output: input.output || {},
      status: "active",
      next_run_at: nextRunAt?.toISOString() || null,
    })
    .select()
    .single();

  if (error) throw error;

  scheduleAutomation(data);

  return data;
}

export async function getAutomations(uid: string) {
  const db = getSupabase();
  const { data, error } = await db
    .from("automations")
    .select("*")
    .eq("uid", uid)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function getAutomation(id: string, uid: string) {
  const db = getSupabase();
  const { data, error } = await db
    .from("automations")
    .select("*")
    .eq("id", id)
    .eq("uid", uid)
    .single();
  if (error) throw error;
  return data;
}

export async function updateAutomation(
  id: string,
  uid: string,
  updates: Record<string, any>
) {
  const db = getSupabase();
  if (updates.schedule) {
    const nextRunAt = computeNextRun(updates.schedule.type, updates.schedule.time);
    updates.next_run_at = nextRunAt?.toISOString() || null;
  }
  updates.updated_at = new Date().toISOString();

  const { data, error } = await db
    .from("automations")
    .update(updates)
    .eq("id", id)
    .eq("uid", uid)
    .select()
    .single();
  if (error) throw error;

  if (data.status === "active") {
    scheduleAutomation(data);
  } else {
    unscheduleAutomation(data.id);
  }

  return data;
}

export async function deleteAutomation(id: string, uid: string) {
  const db = getSupabase();
  unscheduleAutomation(id);
  const { error } = await db
    .from("automations")
    .delete()
    .eq("id", id)
    .eq("uid", uid);
  if (error) throw error;
}

export async function runAutomationNow(id: string, uid: string) {
  const automation = await getAutomation(id, uid);
  return executeAutomationRun(automation);
}

export async function getAutomationRuns(automationId: string, uid: string) {
  const db = getSupabase();
  const { data, error } = await db
    .from("automation_runs")
    .select("*")
    .eq("automation_id", automationId)
    .eq("uid", uid)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw error;
  return data || [];
}

async function executeAutomationRun(automation: any) {
  const db = getSupabase();
  const startedAt = new Date();

  const { data: run, error: insertError } = await db
    .from("automation_runs")
    .insert({
      automation_id: automation.id,
      uid: automation.uid,
      status: "running",
      started_at: startedAt.toISOString(),
      logs: JSON.stringify([{ ts: startedAt.toISOString(), msg: "Hermes workflow started" }]),
    })
    .select()
    .single();
  if (insertError) throw insertError;

  try {
    const prompt = buildHermesWorkflowPrompt({
      title: automation.title,
      description: automation.description,
      scheduleType: automation.schedule?.type || "once",
      time: automation.schedule?.time,
      outputFormat: automation.output?.format || "summary",
    });

    const result = await runHermesAgent({ prompt, timeoutMs: 180000 });

    const finishedAt = new Date();
    const { error: updateError } = await db
      .from("automation_runs")
      .update({
        status: "completed",
        finished_at: finishedAt.toISOString(),
        result: result,
        logs: JSON.stringify([
          ...(JSON.parse(run.logs as string) || []),
          { ts: finishedAt.toISOString(), msg: "Hermes completed" },
        ]),
      })
      .eq("id", run.id);
    if (updateError) console.error("Update run error:", updateError);

    await db
      .from("automations")
      .update({
        last_run_at: finishedAt.toISOString(),
        next_run_at: computeNextRun(
          automation.schedule?.type || "once",
          automation.schedule?.time
        )?.toISOString() || null,
      })
      .eq("id", automation.id);

    return { runId: run.id, status: "completed", result };
  } catch (err: any) {
    const finishedAt = new Date();
    await db
      .from("automation_runs")
      .update({
        status: "failed",
        finished_at: finishedAt.toISOString(),
        error: err.message || String(err),
        logs: JSON.stringify([
          ...(JSON.parse(run.logs as string) || []),
          { ts: finishedAt.toISOString(), msg: `Failed: ${err.message}` },
        ]),
      })
      .eq("id", run.id);
    throw err;
  }
}

function computeNextRun(
  type: string,
  time?: string
): Date | null {
  if (type === "once") return null;
  const [hours = 8, minutes = 0] = (time || "08:00").split(":").map(Number);
  const now = new Date();
  let next = new Date(now);
  next.setHours(hours, minutes, 0, 0);

  if (type === "daily") {
    if (next <= now) next.setDate(next.getDate() + 1);
  } else if (type === "weekly") {
    const dayOfWeek = next.getDay();
    const daysUntilMonday = (8 - dayOfWeek) % 7;
    next.setDate(next.getDate() + (daysUntilMonday || 7));
    if (next <= now) next.setDate(next.getDate() + 7);
  } else if (type === "monthly") {
    next.setDate(1);
    if (next <= now) next.setMonth(next.getMonth() + 1);
  }

  return next;
}

function scheduleAutomation(automation: any) {
  unscheduleAutomation(automation.id);
  if (automation.status !== "active") return;

  const schedule = automation.schedule || {};
  const type = schedule.type;
  const [hours = 8, minutes = 0] = (schedule.time || "08:00").split(":").map(Number);

  let cronExpr: string | null = null;
  if (type === "daily") cronExpr = `${minutes} ${hours} * * *`;
  else if (type === "weekly") cronExpr = `${minutes} ${hours} * * 1`;
  else if (type === "monthly") cronExpr = `${minutes} ${hours} 1 * *`;

  if (!cronExpr) return;

  const task = cron.schedule(cronExpr, () => {
    executeAutomationRun(automation).catch((err) =>
      console.error(`Automation ${automation.id} run failed:`, err)
    );
  });
  scheduledJobs.set(automation.id, task);
  console.log(`Scheduled automation ${automation.id}: ${cronExpr}`);
}

function unscheduleAutomation(id: string) {
  const existing = scheduledJobs.get(id);
  if (existing) {
    existing.stop();
    scheduledJobs.delete(id);
  }
}

export async function loadAndScheduleAll() {
  try {
    const db = getSupabase();
    const { data, error } = await db
      .from("automations")
      .select("*")
      .eq("status", "active");
    if (error) {
      console.error("Failed to load automations for scheduling:", error.message);
      return;
    }
    for (const automation of data || []) {
      scheduleAutomation(automation);
    }
    console.log(`Loaded ${data?.length || 0} automations into scheduler.`);
  } catch (err: any) {
    console.error("Error loading automations:", err.message);
  }
}
