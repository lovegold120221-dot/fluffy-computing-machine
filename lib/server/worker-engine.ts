import crypto from "crypto";
import { runTerminalCommand, runHermesAgent, runSubAgents, generateWithOllama } from "./vps-bridge";

interface Task {
  taskId: string;
  description: string;
  status: "pending" | "running" | "completed" | "failed";
  logs: string[];
  result?: any;
  error?: string;
  createdAt: number;
  completedAt?: number;
}

const tasks = new Map<string, Task>();

function getTask(taskId: string): Task | undefined {
  return tasks.get(taskId);
}

function getAllTasks(): Task[] {
  return Array.from(tasks.values()).sort((a, b) => b.createdAt - a.createdAt);
}

function addLog(taskId: string, line: string) {
  const task = tasks.get(taskId);
  if (task) {
    task.logs.push(line);
  }
}

export async function delegateTask(input: {
  description: string;
  type: "terminal" | "ollama" | "hermes" | "subagents";
  params: Record<string, any>;
  timeoutMs?: number;
}): Promise<{ taskId: string }> {
  const taskId = crypto.createHash("sha256").update(input.description + Date.now()).digest("hex").slice(0, 12);

  const task: Task = {
    taskId,
    description: input.description,
    status: "pending",
    logs: [],
    createdAt: Date.now(),
  };
  tasks.set(taskId, task);

  addLog(taskId, `Task queued: ${input.description}`);

  executeTask(taskId, input).catch((err) => {
    const task = tasks.get(taskId);
    if (task) {
      task.status = "failed";
      task.error = err.message || String(err);
      task.completedAt = Date.now();
      addLog(taskId, `Failed: ${task.error}`);
    }
  });

  return { taskId };
}

async function executeTask(
  taskId: string,
  input: { description: string; type: string; params: Record<string, any>; timeoutMs?: number }
) {
  const task = tasks.get(taskId);
  if (!task) return;

  task.status = "running";
  addLog(taskId, "Starting execution...");

  let result: any;

  switch (input.type) {
    case "terminal": {
      addLog(taskId, `Running: ${input.params.command}`);
      result = await runTerminalCommand({
        command: input.params.command,
        cwd: input.params.cwd,
        scope: input.params.scope || "sandbox",
        timeoutMs: input.params.timeoutMs || input.timeoutMs || 60000,
      });
      if (result.stdout) addLog(taskId, result.stdout.slice(0, 2000));
      if (result.stderr) addLog(taskId, `stderr: ${result.stderr.slice(0, 1000)}`);
      break;
    }
    case "ollama": {
      addLog(taskId, `Querying Ollama model...`);
      result = await generateWithOllama({
        prompt: input.params.prompt,
        model: input.params.model,
        target: input.params.target || "self",
        system: input.params.system,
        timeoutMs: input.params.timeoutMs || input.timeoutMs || 120000,
      });
      break;
    }
    case "hermes": {
      addLog(taskId, "Routing through Hermes agent...");
      result = await runHermesAgent({
        prompt: input.params.prompt,
        timeoutMs: input.params.timeoutMs || input.timeoutMs || 120000,
      });
      if (result.result?.stdout) addLog(taskId, result.result.stdout.slice(0, 2000));
      break;
    }
    case "subagents": {
      addLog(taskId, "Dispatching sub-agents...");
      result = await runSubAgents({
        task: input.params.task,
        model: input.params.model,
        target: input.params.target || "self",
        timeoutMs: input.params.timeoutMs || input.timeoutMs || 150000,
      });
      if (result.agents) {
        for (const agent of result.agents) {
          addLog(taskId, `${agent.name}: ${agent.ok ? "completed" : "failed"}`);
        }
      }
      break;
    }
  }

  task.result = result;
  task.status = "completed";
  task.completedAt = Date.now();
  addLog(taskId, "Task completed.");
}

export function getTaskStatus(taskId: string) {
  const task = getTask(taskId);
  if (!task) return null;
  return {
    taskId: task.taskId,
    description: task.description,
    status: task.status,
    logs: task.logs,
    result: task.result,
    error: task.error,
    createdAt: task.createdAt,
    completedAt: task.completedAt,
  };
}

export function getActiveTasks() {
  return getAllTasks().filter((t) => t.status === "running" || t.status === "pending");
}
