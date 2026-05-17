import React, { useCallback, useEffect, useMemo, useState } from "react";
import * as api from "../lib/api-client";

type OllamaTarget = "self" | "cloud";
type CommandScope = "sandbox" | "system";

function StatusBadge({ ok, label }: { ok?: boolean; label: string }) {
  return (
    <span style={{
      display: "inline-flex",
      alignItems: "center",
      gap: "6px",
      padding: "4px 8px",
      borderRadius: "999px",
      fontSize: "11px",
      fontWeight: 700,
      color: ok ? "var(--bg-main)" : "var(--text-muted)",
      background: ok ? "var(--accent-active)" : "rgba(255,255,255,0.06)",
      border: ok ? "none" : "1px solid var(--border-color)",
    }}>
      <i className={`ph-bold ${ok ? "ph-check-circle" : "ph-warning-circle"}`}></i>
      {label}
    </span>
  );
}

function OutputBlock({ value, minHeight = 120 }: { value: string; minHeight?: number }) {
  return (
    <pre style={{
      minHeight,
      maxHeight: "320px",
      overflow: "auto",
      whiteSpace: "pre-wrap",
      wordBreak: "break-word",
      background: "#050505",
      border: "1px solid var(--border-color)",
      borderRadius: "10px",
      padding: "12px",
      color: "#d7ff8a",
      fontSize: "12px",
      lineHeight: 1.5,
      userSelect: "text",
    }}>
      {value || "No output yet."}
    </pre>
  );
}

export default function VpsOpsPanel() {
  const [status, setStatus] = useState<any>(null);
  const [statusError, setStatusError] = useState("");
  const [loadingStatus, setLoadingStatus] = useState(false);

  const [target, setTarget] = useState<OllamaTarget>("self");
  const [models, setModels] = useState<any[]>([]);
  const [model, setModel] = useState("");
  const [modelsError, setModelsError] = useState("");

  const [command, setCommand] = useState("pwd && ls -la");
  const [commandScope, setCommandScope] = useState<CommandScope>("sandbox");
  const [commandCwd, setCommandCwd] = useState("");
  const [commandOutput, setCommandOutput] = useState("");
  const [commandBusy, setCommandBusy] = useState(false);

  const [ollamaPrompt, setOllamaPrompt] = useState("Summarize the VPS runtime status in five bullet points.");
  const [ollamaOutput, setOllamaOutput] = useState("");
  const [ollamaBusy, setOllamaBusy] = useState(false);

  const [hermesPrompt, setHermesPrompt] = useState("Inspect the current VPS agent environment and return the useful next action.");
  const [hermesOutput, setHermesOutput] = useState("");
  const [hermesBusy, setHermesBusy] = useState(false);

  const [subAgentTask, setSubAgentTask] = useState("Review this app bridge and identify the fastest production hardening steps.");
  const [subAgentOutput, setSubAgentOutput] = useState("");
  const [subAgentBusy, setSubAgentBusy] = useState(false);

  const modelNames = useMemo(
    () => models.map((item) => item.name || item.model).filter(Boolean),
    [models]
  );

  const loadStatus = useCallback(async () => {
    setLoadingStatus(true);
    setStatusError("");
    try {
      const nextStatus = await api.fetchVpsStatus();
      setStatus(nextStatus);
      const seededModels = nextStatus?.ollama?.[target]?.models;
      if (Array.isArray(seededModels)) setModels(seededModels);
    } catch (err: any) {
      setStatusError(err.message || String(err));
    } finally {
      setLoadingStatus(false);
    }
  }, [target]);

  const loadModels = useCallback(async (nextTarget: OllamaTarget = target) => {
    setModelsError("");
    try {
      const data = await api.fetchVpsOllamaModels(nextTarget);
      setModels(data.models || []);
    } catch (err: any) {
      setModels([]);
      setModelsError(err.message || String(err));
    }
  }, [target]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    void loadModels(target);
  }, [target, loadModels]);

  useEffect(() => {
    if (!model && modelNames.length > 0) setModel(modelNames[0]);
    if (model && modelNames.length > 0 && !modelNames.includes(model)) setModel(modelNames[0]);
  }, [model, modelNames]);

  const runCommand = async () => {
    if (!command.trim()) return;
    setCommandBusy(true);
    setCommandOutput("");
    try {
      const result = await api.runVpsCommand({
        command,
        cwd: commandCwd || undefined,
        scope: commandScope,
        timeoutMs: 60_000,
        confirmSystem: commandScope === "system",
      });
      setCommandOutput([
        `$ ${command}`,
        `scope=${commandScope} exit=${result.exitCode ?? "unknown"} duration=${result.durationMs}ms`,
        result.stdout ? `--- stdout ---\n${result.stdout}` : "",
        result.stderr ? `--- stderr ---\n${result.stderr}` : "",
      ].filter(Boolean).join("\n\n"));
    } catch (err: any) {
      setCommandOutput(err.message || String(err));
    } finally {
      setCommandBusy(false);
    }
  };

  const runOllama = async () => {
    if (!ollamaPrompt.trim()) return;
    setOllamaBusy(true);
    setOllamaOutput("");
    try {
      const result = await api.generateVpsOllama({
        target,
        model,
        prompt: ollamaPrompt,
        timeoutMs: 120_000,
      });
      setOllamaOutput(`model=${result.model} target=${result.target}\n\n${result.response || JSON.stringify(result.raw, null, 2)}`);
    } catch (err: any) {
      setOllamaOutput(err.message || String(err));
    } finally {
      setOllamaBusy(false);
    }
  };

  const runHermes = async () => {
    if (!hermesPrompt.trim()) return;
    setHermesBusy(true);
    setHermesOutput("");
    try {
      const result = await api.runVpsHermes({ prompt: hermesPrompt, timeoutMs: 120_000 });
      setHermesOutput([
        `mode=${result.commandMode}`,
        result.cli ? `cli=${result.cli}` : "",
        result.result?.stdout ? `--- stdout ---\n${result.result.stdout}` : "",
        result.result?.stderr ? `--- stderr ---\n${result.result.stderr}` : "",
      ].filter(Boolean).join("\n\n"));
    } catch (err: any) {
      setHermesOutput(err.message || String(err));
    } finally {
      setHermesBusy(false);
    }
  };

  const runSubAgents = async () => {
    if (!subAgentTask.trim()) return;
    setSubAgentBusy(true);
    setSubAgentOutput("");
    try {
      const result = await api.runVpsSubAgents({
        task: subAgentTask,
        target,
        model,
        timeoutMs: 150_000,
      });
      const output = (result.agents || []).map((agent: any) => {
        if (!agent.ok) return `## ${agent.name}\nERROR: ${agent.error?.message || "failed"}`;
        return `## ${agent.name}\n${agent.result?.response || ""}`;
      }).join("\n\n");
      setSubAgentOutput(`task=${result.taskHash} target=${result.target} model=${result.model || model}\n\n${output}`);
    } catch (err: any) {
      setSubAgentOutput(err.message || String(err));
    } finally {
      setSubAgentBusy(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "18px", paddingBottom: "32px" }}>
      <section style={{ padding: "16px", border: "1px solid var(--border-color)", borderRadius: "12px", background: "rgba(255,255,255,0.03)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", marginBottom: "12px" }}>
          <div>
            <h3 style={{ fontSize: "15px", marginBottom: "4px" }}>VPS Bridge</h3>
            <p style={{ color: "var(--text-muted)", fontSize: "12px" }}>
              {status ? `${status.user}@${status.host}:${status.port}` : "Checking remote bridge..."}
            </p>
          </div>
          <button className="pill-btn" onClick={loadStatus} disabled={loadingStatus}>
            {loadingStatus ? "Checking..." : "Refresh"}
          </button>
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
          <StatusBadge ok={status?.configured} label="Config" />
          <StatusBadge ok={status?.ssh?.ok} label="SSH" />
          <StatusBadge ok={status?.ollama?.self?.ok} label={`Ollama Self${status?.ollama?.self?.count ? ` ${status.ollama.self.count}` : ""}`} />
          <StatusBadge ok={status?.ollama?.cloud?.ok} label="Ollama Cloud" />
          <StatusBadge ok={status?.hermes?.ok} label="Hermes CLI" />
        </div>

        {(statusError || status?.ssh?.error) && (
          <p style={{ marginTop: "12px", color: "#ff8888", fontSize: "12px" }}>{statusError || status.ssh.error}</p>
        )}
        {status?.ssh?.uptime && (
          <p style={{ marginTop: "12px", color: "var(--text-muted)", fontSize: "12px" }}>
            {status.ssh.hostname} · {status.ssh.uptime} · sandbox {status.sandboxDir}
          </p>
        )}
      </section>

      <section style={{ display: "grid", gap: "12px" }}>
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          <select className="form-input" style={{ flex: "0 0 150px" }} value={target} onChange={(e) => setTarget(e.target.value as OllamaTarget)}>
            <option value="self">Self-hosted</option>
            <option value="cloud">Cloud URL</option>
          </select>
          <select className="form-input" style={{ flex: "1 1 220px" }} value={model} onChange={(e) => setModel(e.target.value)}>
            <option value="">Select model</option>
            {modelNames.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
          <button className="pill-btn" onClick={() => loadModels(target)}>Models</button>
        </div>
        {modelsError && <p style={{ color: "#ff8888", fontSize: "12px" }}>{modelsError}</p>}
      </section>

      <section style={{ display: "grid", gap: "10px" }}>
        <h3 style={{ fontSize: "15px" }}>Sandbox Terminal</h3>
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          <select className="form-input" style={{ flex: "0 0 140px" }} value={commandScope} onChange={(e) => setCommandScope(e.target.value as CommandScope)}>
            <option value="sandbox">Sandbox</option>
            <option value="system">System</option>
          </select>
          <input className="form-input" style={{ flex: "1 1 180px" }} value={commandCwd} onChange={(e) => setCommandCwd(e.target.value)} placeholder="optional sandbox cwd" />
        </div>
        <textarea className="form-input" rows={3} value={command} onChange={(e) => setCommand(e.target.value)} />
        <button className="save-now-btn" onClick={runCommand} disabled={commandBusy}>{commandBusy ? "Running..." : "Run Command"}</button>
        <OutputBlock value={commandOutput} />
      </section>

      <section style={{ display: "grid", gap: "10px" }}>
        <h3 style={{ fontSize: "15px" }}>Ollama Prompt</h3>
        <textarea className="form-input" rows={4} value={ollamaPrompt} onChange={(e) => setOllamaPrompt(e.target.value)} />
        <button className="save-now-btn" onClick={runOllama} disabled={ollamaBusy || !model}>{ollamaBusy ? "Generating..." : "Run Ollama"}</button>
        <OutputBlock value={ollamaOutput} />
      </section>

      <section style={{ display: "grid", gap: "10px" }}>
        <h3 style={{ fontSize: "15px" }}>Hermes Agent CLI</h3>
        <textarea className="form-input" rows={4} value={hermesPrompt} onChange={(e) => setHermesPrompt(e.target.value)} />
        <button className="save-now-btn" onClick={runHermes} disabled={hermesBusy}>{hermesBusy ? "Running..." : "Run Hermes"}</button>
        <OutputBlock value={hermesOutput} />
      </section>

      <section style={{ display: "grid", gap: "10px" }}>
        <h3 style={{ fontSize: "15px" }}>Ollama Sub-Agents</h3>
        <textarea className="form-input" rows={4} value={subAgentTask} onChange={(e) => setSubAgentTask(e.target.value)} />
        <button className="save-now-btn" onClick={runSubAgents} disabled={subAgentBusy || !model}>{subAgentBusy ? "Dispatching..." : "Run Sub-Agents"}</button>
        <OutputBlock value={subAgentOutput} minHeight={180} />
      </section>
    </div>
  );
}
