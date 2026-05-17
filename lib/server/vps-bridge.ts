import crypto from "crypto";
import { Client, type ConnectConfig } from "ssh2";

type SshExecResult = {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  timedOut: boolean;
};

type VpsConfig = {
  host: string;
  port: number;
  user: string;
  password: string;
  fingerprint?: string;
  sandboxDir: string;
  ollamaSelfUrl: string;
  ollamaCloudUrl: string;
  ollamaDefaultModel: string;
  hermesCommand: string;
  allowSystemCommands: boolean;
  sshReadyTimeoutMs: number;
};

export class VpsBridgeError extends Error {
  code: string;
  statusCode: number;
  details?: unknown;

  constructor(code: string, message: string, statusCode = 500, details?: unknown) {
    super(message);
    this.name = "VpsBridgeError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

const MAX_OUTPUT_CHARS = 160_000;

function getVpsConfig(): VpsConfig {
  return {
    host: process.env.VPS_SSH_HOST || "168.231.78.113",
    port: Number(process.env.VPS_SSH_PORT || 22),
    user: process.env.VPS_SSH_USER || "root",
    password: process.env.VPS_SSH_PASSWORD || "",
    fingerprint: process.env.VPS_SSH_HOST_FINGERPRINT?.replace(/^SHA256:/, "").trim(),
    sandboxDir: process.env.VPS_SANDBOX_DIR || "/tmp/eburon-vcall-sandbox",
    ollamaSelfUrl: process.env.VPS_OLLAMA_SELF_URL || "http://127.0.0.1:11434",
    ollamaCloudUrl: process.env.VPS_OLLAMA_CLOUD_URL || "",
    ollamaDefaultModel: process.env.VPS_OLLAMA_DEFAULT_MODEL || "",
    hermesCommand: process.env.VPS_HERMES_COMMAND || "",
    allowSystemCommands: process.env.VPS_ALLOW_SYSTEM_COMMANDS === "true",
    sshReadyTimeoutMs: Number(process.env.VPS_SSH_READY_TIMEOUT_MS || 12_000),
  };
}

export function getVpsPublicConfig() {
  const config = getVpsConfig();
  return {
    host: config.host,
    port: config.port,
    user: config.user,
    configured: Boolean(config.password),
    sandboxDir: config.sandboxDir,
    allowSystemCommands: config.allowSystemCommands,
    ollamaSelfUrl: config.ollamaSelfUrl,
    ollamaCloudConfigured: Boolean(config.ollamaCloudUrl),
    ollamaDefaultModel: config.ollamaDefaultModel,
    hermesConfigured: Boolean(config.hermesCommand),
    fingerprintConfigured: Boolean(config.fingerprint),
  };
}

function ensureConfigured(config = getVpsConfig()) {
  if (!config.password) {
    throw new VpsBridgeError(
      "VPS_SSH_PASSWORD_MISSING",
      "VPS_SSH_PASSWORD is not configured on the server.",
      500
    );
  }
}

function redactSecrets(value: string) {
  const { password } = getVpsConfig();
  if (!password) return value;
  return value.split(password).join("[redacted]");
}

function shQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function fingerprintMatches(hashedKey: string, expected: string) {
  const cleanHashedKey = hashedKey.trim().replace(/^SHA256:/, "");
  const cleanExpected = expected.trim().replace(/^SHA256:/, "");
  const variants = new Set([cleanExpected, cleanExpected.toLowerCase()]);

  try {
    variants.add(Buffer.from(cleanExpected, "base64").toString("hex"));
  } catch {
    // Keep the original configured value as the only variant.
  }

  return variants.has(cleanHashedKey) || variants.has(cleanHashedKey.toLowerCase());
}

function parseKeyValueLines(stdout: string) {
  return stdout.split(/\r?\n/).reduce<Record<string, string>>((acc, line) => {
    const index = line.indexOf("=");
    if (index > 0) {
      acc[line.slice(0, index)] = line.slice(index + 1);
    }
    return acc;
  }, {});
}

async function withSsh<T>(handler: (conn: Client) => Promise<T>): Promise<T> {
  const config = getVpsConfig();
  ensureConfigured(config);

  return new Promise<T>((resolve, reject) => {
    const conn = new Client();
    let settled = false;
    const timer = setTimeout(() => {
      finish(
        new VpsBridgeError(
          "VPS_SSH_TIMEOUT",
          `Timed out connecting to ${config.user}@${config.host}:${config.port}.`,
          504
        )
      );
    }, config.sshReadyTimeoutMs + 2_000);

    const finish = (err?: unknown, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      conn.end();
      if (err) reject(normalizeBridgeError(err));
      else resolve(value as T);
    };

    conn.on("ready", () => {
      clearTimeout(timer);
      handler(conn).then((value) => finish(undefined, value)).catch(finish);
    });

    conn.on("error", (err) => finish(err));

    const sshConfig: ConnectConfig = {
      host: config.host,
      port: config.port,
      username: config.user,
      password: config.password,
      readyTimeout: config.sshReadyTimeoutMs,
      keepaliveInterval: 10_000,
    };

    if (config.fingerprint) {
      sshConfig.hostHash = "sha256";
      sshConfig.hostVerifier = (hashedKey) => fingerprintMatches(hashedKey, config.fingerprint || "");
    }

    conn.connect(sshConfig);
  });
}

function normalizeBridgeError(err: unknown) {
  if (err instanceof VpsBridgeError) return err;
  const raw = err instanceof Error ? err.message : String(err);
  const message = redactSecrets(raw);
  if (/authentication|permission denied|All configured authentication methods failed/i.test(message)) {
    return new VpsBridgeError("VPS_SSH_AUTH_FAILED", "SSH authentication failed for the configured VPS user.", 401);
  }
  if (/Host denied|fingerprint|hostVerifier/i.test(message)) {
    return new VpsBridgeError("VPS_SSH_HOST_VERIFY_FAILED", "VPS SSH host fingerprint verification failed.", 502);
  }
  return new VpsBridgeError("VPS_BRIDGE_ERROR", message, 500);
}

export async function sshExec(command: string, timeoutMs = 30_000): Promise<SshExecResult> {
  const startedAt = Date.now();

  return withSsh((conn) => new Promise<SshExecResult>((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) {
        reject(err);
        return;
      }

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let truncated = false;

      const append = (target: "stdout" | "stderr", chunk: Buffer) => {
        const text = chunk.toString("utf8");
        const current = target === "stdout" ? stdout : stderr;
        if (current.length >= MAX_OUTPUT_CHARS) {
          truncated = true;
          return;
        }
        const next = current + text.slice(0, MAX_OUTPUT_CHARS - current.length);
        if (target === "stdout") stdout = next;
        else stderr = next;
      };

      const timer = setTimeout(() => {
        timedOut = true;
        stream.close();
      }, timeoutMs);

      stream.on("data", (chunk: Buffer) => append("stdout", chunk));
      stream.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));

      stream.on("close", (exitCode: number | null, signal: string | null) => {
        clearTimeout(timer);
        if (truncated) stderr += "\n[output truncated]";
        if (timedOut) stderr += `\n[command timed out after ${timeoutMs}ms]`;
        resolve({
          command,
          stdout: redactSecrets(stdout),
          stderr: redactSecrets(stderr),
          exitCode,
          signal,
          durationMs: Date.now() - startedAt,
          timedOut,
        });
      });
    });
  }));
}

function assertSafeRelativePath(cwd?: string) {
  if (!cwd) return "";
  const normalized = cwd.trim();
  if (!normalized || normalized === ".") return "";
  if (normalized.startsWith("/") || normalized.includes("..") || normalized.includes("\0")) {
    throw new VpsBridgeError("INVALID_SANDBOX_PATH", "Sandbox cwd must be a relative path inside the sandbox.", 400);
  }
  return normalized.replace(/^\.\/+/, "");
}

function assertCommandAllowed(command: string) {
  const blocked = [
    /\brm\s+-rf\s+\/(?:\s|$)/i,
    /\b(mkfs|fdisk|parted|shutdown|reboot|poweroff|halt|init)\b/i,
    /\bdd\s+if=/i,
    /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}/,
    /\b(chmod|chown)\s+-R\s+[^&|;]*\s\/(?:\s|$)/i,
    /\b(curl|wget)\b[^|;&]+[|]\s*(sh|bash)\b/i,
  ];

  if (blocked.some((pattern) => pattern.test(command))) {
    throw new VpsBridgeError("COMMAND_BLOCKED", "Command blocked by VPS safety policy.", 400);
  }
}

export async function runTerminalCommand(input: {
  command: string;
  cwd?: string;
  scope?: "sandbox" | "system";
  timeoutMs?: number;
  confirmSystem?: boolean;
}) {
  const config = getVpsConfig();
  const timeoutMs = Math.min(Math.max(input.timeoutMs || 30_000, 1_000), 120_000);
  const seconds = Math.ceil(timeoutMs / 1000);
  const scope = input.scope || "sandbox";

  assertCommandAllowed(input.command);

  if (scope === "system") {
    if (!config.allowSystemCommands || !input.confirmSystem) {
      throw new VpsBridgeError(
        "SYSTEM_COMMANDS_DISABLED",
        "System command execution is disabled. Use sandbox scope or set VPS_ALLOW_SYSTEM_COMMANDS=true and confirm the request.",
        403
      );
    }
    return sshExec(`timeout ${seconds}s bash -lc ${shQuote(input.command)}`, timeoutMs + 5_000);
  }

  const relativeCwd = assertSafeRelativePath(input.cwd);
  const sandboxPath = relativeCwd ? `${config.sandboxDir}/${relativeCwd}` : config.sandboxDir;
  const remoteCommand = [
    `mkdir -p ${shQuote(sandboxPath)}`,
    `cd ${shQuote(sandboxPath)}`,
    `timeout ${seconds}s bash -lc ${shQuote(input.command)}`,
  ].join(" && ");

  return sshExec(remoteCommand, timeoutMs + 5_000);
}

function ollamaUrlForTarget(target: "self" | "cloud") {
  const config = getVpsConfig();
  if (target === "self") return config.ollamaSelfUrl;
  if (!config.ollamaCloudUrl) {
    throw new VpsBridgeError("OLLAMA_CLOUD_NOT_CONFIGURED", "VPS_OLLAMA_CLOUD_URL is not configured.", 400);
  }
  return config.ollamaCloudUrl;
}

async function remoteJsonGet(url: string, timeoutMs = 15_000) {
  const seconds = Math.ceil(timeoutMs / 1000);
  const result = await sshExec(`curl -fsS --max-time ${seconds} ${shQuote(url)}`, timeoutMs + 5_000);
  if (result.exitCode !== 0) {
    throw new VpsBridgeError("REMOTE_HTTP_ERROR", result.stderr || `Remote GET failed for ${url}`, 502, result);
  }
  return JSON.parse(result.stdout);
}

async function remoteJsonPost(url: string, payload: unknown, timeoutMs = 60_000) {
  const seconds = Math.ceil(timeoutMs / 1000);
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  const remoteCommand = [
    `PAYLOAD=$(printf %s ${shQuote(payloadB64)} | base64 -d)`,
    `curl -fsS --max-time ${seconds} -H 'Content-Type: application/json' -X POST --data-binary "$PAYLOAD" ${shQuote(url)}`,
  ].join(" && ");
  const result = await sshExec(remoteCommand, timeoutMs + 5_000);
  if (result.exitCode !== 0) {
    throw new VpsBridgeError("REMOTE_HTTP_ERROR", result.stderr || `Remote POST failed for ${url}`, 502, result);
  }
  return JSON.parse(result.stdout);
}

export async function listOllamaModels(target: "self" | "cloud" = "self") {
  const baseUrl = ollamaUrlForTarget(target).replace(/\/$/, "");
  const raw = await remoteJsonGet(`${baseUrl}/api/tags`, 15_000);
  return {
    target,
    baseUrl,
    models: Array.isArray(raw.models) ? raw.models : [],
    raw,
  };
}

export async function generateWithOllama(input: {
  target?: "self" | "cloud";
  model?: string;
  prompt: string;
  system?: string;
  timeoutMs?: number;
}) {
  const config = getVpsConfig();
  const target = input.target || "self";
  const baseUrl = ollamaUrlForTarget(target).replace(/\/$/, "");
  const model = input.model || config.ollamaDefaultModel;

  if (!model) {
    throw new VpsBridgeError("OLLAMA_MODEL_REQUIRED", "An Ollama model is required.", 400);
  }

  const payload = {
    model,
    prompt: input.prompt,
    system: input.system || undefined,
    stream: false,
  };
  const raw = await remoteJsonPost(`${baseUrl}/api/generate`, payload, input.timeoutMs || 90_000);
  return {
    target,
    model,
    response: raw.response || "",
    raw,
  };
}

async function detectHermesCli() {
  const result = await sshExec(
    "command -v hermes-agent-cli || command -v hermes-agent || command -v hermes || true",
    15_000
  );
  return result.stdout.trim().split(/\r?\n/)[0] || "";
}

export async function runHermesAgent(input: { prompt: string; timeoutMs?: number }) {
  const config = getVpsConfig();
  const timeoutMs = Math.min(Math.max(input.timeoutMs || 90_000, 5_000), 180_000);
  const seconds = Math.ceil(timeoutMs / 1000);
  const promptB64 = Buffer.from(input.prompt, "utf8").toString("base64");
  const stdinPrefix = `printf %s ${shQuote(promptB64)} | base64 -d`;

  if (config.hermesCommand) {
    const result = await sshExec(`${stdinPrefix} | timeout ${seconds}s ${config.hermesCommand}`, timeoutMs + 5_000);
    return { commandMode: "configured", cli: config.hermesCommand, result };
  }

  const cli = await detectHermesCli();
  if (!cli) {
    throw new VpsBridgeError(
      "HERMES_CLI_NOT_FOUND",
      "No Hermes CLI binary was found on the VPS. Set VPS_HERMES_COMMAND to the exact remote command that reads a prompt from stdin.",
      404
    );
  }

  const attempts = [
    { mode: "run-stdin", command: `${stdinPrefix} | timeout ${seconds}s ${shQuote(cli)} run --stdin` },
    { mode: "run-arg", command: `timeout ${seconds}s ${shQuote(cli)} run ${shQuote(input.prompt)}` },
    { mode: "arg", command: `timeout ${seconds}s ${shQuote(cli)} ${shQuote(input.prompt)}` },
  ];

  let lastResult: SshExecResult | null = null;
  for (const attempt of attempts) {
    const result = await sshExec(attempt.command, timeoutMs + 5_000);
    lastResult = result;
    if (result.exitCode === 0 && result.stdout.trim()) {
      return { commandMode: attempt.mode, cli, result };
    }
  }

  return { commandMode: "failed", cli, result: lastResult };
}

const DEFAULT_SUB_AGENTS = [
  {
    id: "architect",
    name: "Architect",
    role: "Break the task into a clean implementation approach, risks, and interfaces.",
  },
  {
    id: "builder",
    name: "Builder",
    role: "Produce concrete implementation steps, commands, and code-level changes.",
  },
  {
    id: "reviewer",
    name: "Reviewer",
    role: "Find correctness, security, and regression risks. Be direct and specific.",
  },
];

export async function runSubAgents(input: {
  task: string;
  target?: "self" | "cloud";
  model?: string;
  agents?: Array<{ id?: string; name?: string; role?: string; model?: string }>;
  timeoutMs?: number;
}) {
  const agents = (input.agents?.length ? input.agents : DEFAULT_SUB_AGENTS).slice(0, 6);
  const taskHash = crypto.createHash("sha256").update(input.task).digest("hex").slice(0, 12);

  const outputs = await Promise.all(
    agents.map(async (agent, index) => {
      const name = agent.name || agent.id || `Agent ${index + 1}`;
      const system = `You are ${name}, a focused remote sub-agent running inside the Eburon VPS bridge. ${agent.role || "Analyze the task and return useful output."}`;
      const prompt = [
        `Task id: ${taskHash}`,
        `Task: ${input.task}`,
        "",
        "Return concise, actionable output. Include commands only when they are directly relevant.",
      ].join("\n");

      try {
        const result = await generateWithOllama({
          target: input.target || "self",
          model: agent.model || input.model,
          prompt,
          system,
          timeoutMs: input.timeoutMs || 120_000,
        });
        return { id: agent.id || name.toLowerCase().replace(/\s+/g, "-"), name, ok: true, result };
      } catch (err) {
        const normalized = normalizeBridgeError(err);
        return {
          id: agent.id || name.toLowerCase().replace(/\s+/g, "-"),
          name,
          ok: false,
          error: { code: normalized.code, message: normalized.message },
        };
      }
    })
  );

  return {
    taskHash,
    target: input.target || "self",
    model: input.model || getVpsConfig().ollamaDefaultModel,
    agents: outputs,
  };
}

export async function getVpsStatus() {
  const publicConfig = getVpsPublicConfig();

  if (!publicConfig.configured) {
    return {
      ...publicConfig,
      ssh: { ok: false, error: "VPS_SSH_PASSWORD is missing." },
      ollama: { self: { ok: false }, cloud: { ok: false, skipped: true } },
      hermes: { ok: false, skipped: true },
    };
  }

  try {
    const identity = await sshExec(
      [
        "echo hostname=$(hostname)",
        "echo user=$(whoami)",
        "echo uptime=$(uptime -p 2>/dev/null || uptime)",
        `mkdir -p ${shQuote(publicConfig.sandboxDir)}`,
        `echo sandbox=${shQuote(publicConfig.sandboxDir)}`,
        "echo ollama_bin=$(command -v ollama || true)",
        "echo hermes_cli=$(command -v hermes-agent-cli || command -v hermes-agent || command -v hermes || true)",
      ].join(" && "),
      20_000
    );
    const parsed = parseKeyValueLines(identity.stdout);

    const [selfModels, cloudModels] = await Promise.all([
      listOllamaModels("self").then((data) => ({ ok: true, count: data.models.length, models: data.models })).catch((err) => {
        const normalized = normalizeBridgeError(err);
        return { ok: false, error: normalized.message };
      }),
      publicConfig.ollamaCloudConfigured
        ? listOllamaModels("cloud").then((data) => ({ ok: true, count: data.models.length, models: data.models })).catch((err) => {
          const normalized = normalizeBridgeError(err);
          return { ok: false, error: normalized.message };
        })
        : Promise.resolve({ ok: false, skipped: true, error: "VPS_OLLAMA_CLOUD_URL is not configured." }),
    ]);

    return {
      ...publicConfig,
      ssh: {
        ok: identity.exitCode === 0,
        hostname: parsed.hostname,
        user: parsed.user,
        uptime: parsed.uptime,
        exitCode: identity.exitCode,
        stderr: identity.stderr || undefined,
      },
      ollama: {
        self: selfModels,
        cloud: cloudModels,
      },
      hermes: {
        ok: Boolean(parsed.hermes_cli || publicConfig.hermesConfigured),
        cli: parsed.hermes_cli || publicConfig.hermesConfigured ? "configured command" : "",
      },
    };
  } catch (err) {
    const normalized = normalizeBridgeError(err);
    return {
      ...publicConfig,
      ssh: { ok: false, error: normalized.message, code: normalized.code },
      ollama: { self: { ok: false, skipped: true }, cloud: { ok: false, skipped: true } },
      hermes: { ok: false, skipped: true },
    };
  }
}
