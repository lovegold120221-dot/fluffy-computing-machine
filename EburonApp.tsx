import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useLiveAPIContext } from './contexts/LiveAPIContext';
import { useLogStore, useTools, useSettings, useUI } from './lib/state';
import { AudioRecorder } from './lib/audio-recorder';
import ReactMarkdown from 'react-markdown';
import { Modality } from '@google/genai';
import { useVideoStream } from './hooks/use-video-stream';
import { LANGUAGES } from './lib/languages';
import { auth, testConnection } from './lib/firebase';
import { signInWithPopup, GoogleAuthProvider, signInWithEmailAndPassword, createUserWithEmailAndPassword, onAuthStateChanged, signOut } from 'firebase/auth';
import * as api from './lib/api-client';
import { useAuth } from './lib/state';
import AutomationPanel from './components/AutomationPanel';
import WhatsAppConnectPanel from './components/WhatsAppConnectPanel';

type PersistedConversationRole = 'user' | 'agent' | 'system';
type PersistedConversationSource = 'voice' | 'text' | 'tool' | 'system' | 'import';

const makeSessionId = () => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `session-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
};

const makeStableHash = (value: string) => {
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
};

const normalizeTurnText = (value: string) => value.replace(/\s+/g, ' ').trim();

export default function EburonApp() {
  const [isAuthOpen, setIsAuthOpen] = useState(true);
  const [isSignupMode, setIsSignupMode] = useState(false);
  const [activeOverlay, setActiveOverlay] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [authError, setAuthError] = useState('');

  const { client, connect, disconnect, connected, volume, setConfig } = useLiveAPIContext();
  const turns = useLogStore((state) => state.turns);
  const tools = useTools((state) => state.tools);
  const setTemplate = useTools((state) => state.setTemplate);

  const {
    voice, setVoice,
    language, setLanguage,
    personaName, setPersonaName,
    userCallName, setUserCallName,
    systemPrompt, setSystemPrompt,
    model
  } = useSettings();

  const activeWorkspaceResult = useUI((state) => state.activeWorkspaceResult);
  const setActiveWorkspaceResult = useUI((state) => state.setActiveWorkspaceResult);

  const {
    showResultPage, setShowResultPage,
    resultData, setResultData
  } = useUI();
  const [micState, setMicState] = useState(false);
  const [clientVolume, setClientVolume] = useState(0);
  const [audioRecorder] = useState(() => new AudioRecorder());
  const [activeTasks, setActiveTasks] = useState<Array<{ taskId: string; description: string; status: string }>>([]);
  const geminiAudioActiveRef = useRef(false);

  const { stream, videoRef, isWebcamActive, isScreenShareActive, facingMode, flipCamera, stopStream, isRecording, recordingPaused, startRecording, togglePauseRecording, takeSnapshot } = useVideoStream();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const bgAudioRef = useRef<HTMLAudioElement>(null);

  // Pause bg audio when Gemini AI is speaking; resume when it stops
  useEffect(() => {
    const isSpeaking = volume > 0.01;
    if (isSpeaking && !geminiAudioActiveRef.current && bgAudioRef.current) {
      geminiAudioActiveRef.current = true;
      bgAudioRef.current.pause();
    } else if (!isSpeaking && geminiAudioActiveRef.current && bgAudioRef.current && connected) {
      geminiAudioActiveRef.current = false;
      bgAudioRef.current.play().catch(() => { });
    }
  }, [volume, connected]);

  useEffect(() => {
    if (bgAudioRef.current) {
      bgAudioRef.current.volume = 0.45;
      if (connected) {
        bgAudioRef.current.play().catch(err => console.log("Bg audio play blocked until interaction:", err));
      } else {
        bgAudioRef.current.pause();
      }
    }
  }, [connected]);

  useEffect(() => {
    const onVolume = (vol: number) => {
      setClientVolume(vol);
    };
    audioRecorder.on('volume', onVolume);
    return () => {
      audioRecorder.off('volume', onVolume);
    };
  }, [audioRecorder]);

  const [message, setMessage] = useState('');
  const [memories, setMemories] = useState<any[]>([]);
  const [editingMemoryIndex, setEditingMemoryIndex] = useState<number | null>(null);
  const [editingMemoryValue, setEditingMemoryValue] = useState<string>('');
  const [editingMemoryType, setEditingMemoryType] = useState<string>('personal');
  const [memoryFilter, setMemoryFilter] = useState<string>('all');
  const [isAddingMemory, setIsAddingMemory] = useState<boolean>(false);
  const [newMemoryValue, setNewMemoryValue] = useState<string>('');
  const [newMemoryType, setNewMemoryType] = useState<string>('personal');
  const [memorySuccessMsg, setMemorySuccessMsg] = useState<string | null>(null);
  const [currentUserProfile, setCurrentUserProfile] = useState<any | null>(null);
  const [longTermTurns, setLongTermTurns] = useState<any[]>([]);
  const [whatsappContacts, setWhatsappContacts] = useState<{ name: string; phoneNumber: string }[]>([]);
  const savedTurnKeysRef = useRef<Set<string>>(new Set());
  const [kbFiles, setKbFiles] = useState<{ name: string; content: string; size: number }[]>([]);

  // Session & Timer State
  const [sessionID, setSessionID] = useState<string>(() => makeSessionId());
  const [timerSeconds, setTimerSeconds] = useState(0);
  const warnedAt19Ref = useRef(false);
  const warnedAt1950Ref = useRef(false);

  // History Filtering State
  const [historySearch, setHistorySearch] = useState('');
  const [historyRoleFilter, setHistoryRoleFilter] = useState<'all' | 'user' | 'agent' | 'system'>('all');
  const [historyToolFilter, setHistoryToolFilter] = useState<'all' | 'search' | 'memory' | 'meeting' | 'artifact' | 'command'>('all');
  const [historyDateRange, setHistoryDateRange] = useState<'all' | 'today' | 'week'>('all');
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [allHistory, setAllHistory] = useState<any[] | null>(null);

  useEffect(() => {
    if (activeOverlay === 'history') {
      api.fetchConversations(1000).then(data => setAllHistory(data)).catch(err => {
        setHistoryError(err.message);
        setAllHistory([]);
      });
    }
  }, [activeOverlay]);

  const chatAreaRef = useRef<HTMLDivElement>(null);

  const saveFinalTurn = useCallback((
    role: PersistedConversationRole,
    rawText: string,
    source: PersistedConversationSource = 'voice',
    timestamp: Date = new Date(),
    metadata: Record<string, unknown> = {}
  ) => {
    const content = normalizeTurnText(rawText);
    if (!content) return;

    const safeTimestamp = Number.isNaN(timestamp.getTime()) ? new Date() : timestamp;
    const clientTurnId = makeStableHash(`${sessionID}:${role}:${source}:${safeTimestamp.getTime()}:${content}`);
    const localKey = `${role}:${clientTurnId}`;

    if (savedTurnKeysRef.current.has(localKey)) return;
    savedTurnKeysRef.current.add(localKey);

    api.saveConversationTurn(role, content, {
      session_id: sessionID,
      source,
      client_turn_id: clientTurnId,
      created_at: safeTimestamp.toISOString(),
      metadata: {
        ...metadata,
        client_timestamp: safeTimestamp.toISOString(),
      },
    }).catch((err) => {
      savedTurnKeysRef.current.delete(localKey);
      console.error("Failed to save conversation turn:", err);
    });
  }, [sessionID]);

  useEffect(() => {
    // testConnection(); // Firestore specific, skipping for now as we use Postgres
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      // Diagnostic health check
      try {
        const health = await fetch("/api/health").then(r => r.json());
        console.log("Backend health check:", health);
      } catch (err) {
        console.error("Backend health check failed (is the server running?):", err);
      }

      if (user) {
        setIsAuthOpen(false);
        setActiveOverlay(null);
        savedTurnKeysRef.current.clear();

        try {
          // Restore Google token from Supabase on page reload
          try {
            const storedToken = await api.fetchGoogleToken();
            if (storedToken?.access_token) {
              useAuth.getState().setGoogleAccessToken(storedToken.access_token);
            }
          } catch (e) {
            // No stored token — user needs to authenticate with Google
          }

          // Fetch Settings
          const settings = await api.fetchSettings();
          setPersonaName(settings.persona_name);
          setUserCallName(settings.user_call_name);
          setSystemPrompt(settings.system_prompt);
          setVoice(settings.voice);
          setLanguage(settings.language);

          let context: any = null;
          try {
            context = await api.fetchConversationContext(200);
            setCurrentUserProfile(context.profile || null);
          } catch (contextError) {
            console.error("Failed to load Supabase context, falling back to direct memory/history fetch:", contextError);
            setCurrentUserProfile(user ? {
              uid: user.uid,
              email: user.email,
              display_name: user.displayName,
              photo_url: user.photoURL,
            } : null);
          }

          // Fetch memories and previous conversation turns for this Firebase UID.
          const memoryList = context?.memories || await api.fetchMemories();
          setMemories(memoryList);
          const prevTurns = context?.recentTurns || await api.fetchConversations(200);
          setLongTermTurns(prevTurns);

          // Fetch WhatsApp contacts metadata for Gemini Live audio context
          try {
            const phonebook = await api.fetchWhatsAppPhonebook();
            if (phonebook?.contacts) {
              setWhatsappContacts(phonebook.contacts.map((c: any) => ({
                name: c.name || c.pushname || 'Unknown',
                phoneNumber: c.phoneNumber || c.id?.split('@')[0] || '',
              })));
            }
          } catch (e) {
            console.log("WhatsApp contacts not available yet");
          }

          try {
            const { turns, addTurn } = useLogStore.getState();
            if (turns.length === 0) {
              if (prevTurns && prevTurns.length > 0) {
                prevTurns.forEach((t: any) => {
                  addTurn({
                    role: t.role,
                    text: t.content,
                    isFinal: true,
                    timestamp: t.created_at ? new Date(t.created_at) : new Date()
                  });
                });
              }
            }
          } catch (err: any) {
            console.error("Failed to load history:", err);
            setHistoryError(err.message);
          }
        } catch (e) {
          console.error("Error loading user data from Postgres:", e);
        }
      } else {
        setIsAuthOpen(true);
        setMemories([]);
        setCurrentUserProfile(null);
        setLongTermTurns([]);
        setAllHistory(null);
        useLogStore.getState().clearTurns();
        savedTurnKeysRef.current.clear();
      }
    });
    return () => unsubscribe();
  }, [setPersonaName, setUserCallName, setSystemPrompt, setVoice, setLanguage]);

  const hasStartedRef = useRef(false);

  // Track silence for 15s filler
  const lastUserSpeechTime = useRef(Date.now());
  const fillerTriggeredRef = useRef(false);
  const aiIsSpeakingRef = useRef(false);

  useEffect(() => {
    if (clientVolume > 0.01) {
      lastUserSpeechTime.current = Date.now();
      fillerTriggeredRef.current = false;
    }
  }, [clientVolume]);

  useEffect(() => {
    if (volume > 0.05) {
      // AI is speaking, reset the silence timer so we count 15s from AFTER it stops
      aiIsSpeakingRef.current = true;
      lastUserSpeechTime.current = Date.now();
      fillerTriggeredRef.current = false;
    } else {
      if (aiIsSpeakingRef.current) {
        aiIsSpeakingRef.current = false;
        lastUserSpeechTime.current = Date.now(); // Start timer exactly when AI stops
      }
    }
  }, [volume]);

  // Accumulated text for the current in-progress turn
  const currentUserText = useRef("");
  const currentAgentText = useRef("");

  useEffect(() => {
    if (!client) return;

    const { addTurn, updateLastTurn } = useLogStore.getState();

    // Helper: finalize the last turn if it's still in-progress for a given role
    const finalizeLastTurnIfNeeded = (role: 'user' | 'agent') => {
      const currentTurns = useLogStore.getState().turns;
      const last = currentTurns[currentTurns.length - 1];
      if (last && last.role === role && !last.isFinal) {
        updateLastTurn({ isFinal: true });
        if (role === 'user') {
          saveFinalTurn('user', last.text, 'voice', last.timestamp);
        } else {
          saveFinalTurn('agent', last.text, 'voice', last.timestamp);
        }
      }
    };

    const handleInputTranscription = (text: string, isFinal: boolean) => {
      const currentTurns = useLogStore.getState().turns;
      const last = currentTurns[currentTurns.length - 1];

      // If the agent was speaking (in-progress), finalize that turn first
      if (last && last.role === 'agent' && !last.isFinal) {
        finalizeLastTurnIfNeeded('agent');
        currentAgentText.current = "";
      }

      // Accumulate text for the current user turn (Gemini fires full transcript each time)
      currentUserText.current = text;
      const fullText = currentUserText.current;

      // Check again after potential finalization
      const updatedTurns = useLogStore.getState().turns;
      const updatedLast = updatedTurns[updatedTurns.length - 1];

      if (updatedLast && updatedLast.role === 'user' && !updatedLast.isFinal) {
        updateLastTurn({ text: fullText });
      } else if (text.trim()) {
        addTurn({ role: 'user', text: fullText, isFinal: false });
      }

      if (isFinal) {
        // Finalize current user turn and reset accumulator for next utterance
        const finalTurns = useLogStore.getState().turns;
        const finalLast = finalTurns[finalTurns.length - 1];
        if (finalLast && finalLast.role === 'user' && !finalLast.isFinal) {
          updateLastTurn({ isFinal: true });
          saveFinalTurn('user', currentUserText.current, 'voice', finalLast.timestamp);
        }
        currentUserText.current = "";
      }
    };

    const handleOutputTranscription = (text: string, isFinal: boolean) => {
      const currentTurns = useLogStore.getState().turns;
      const last = currentTurns[currentTurns.length - 1];

      // If the user was speaking (in-progress), finalize that turn first
      if (last && last.role === 'user' && !last.isFinal) {
        finalizeLastTurnIfNeeded('user');
        currentUserText.current = "";
      }

      // Accumulate text for the current agent turn (Gemini fires full transcript each time)
      currentAgentText.current = text;
      const fullText = currentAgentText.current;

      const updatedTurns = useLogStore.getState().turns;
      const updatedLast = updatedTurns[updatedTurns.length - 1];

      if (updatedLast && updatedLast.role === 'agent' && !updatedLast.isFinal) {
        updateLastTurn({ text: fullText });
      } else if (text.trim()) {
        addTurn({ role: 'agent', text: fullText, isFinal: false });
      }

      if (isFinal) {
        const finalTurns = useLogStore.getState().turns;
        const finalLast = finalTurns[finalTurns.length - 1];
        if (finalLast && finalLast.role === 'agent' && !finalLast.isFinal) {
          updateLastTurn({ isFinal: true });
          saveFinalTurn('agent', currentAgentText.current, 'voice', finalLast.timestamp);
        }
        currentAgentText.current = "";
      }
    };

    const handleContent = (serverContent: any) => {
      // Prioritize outputTranscription for agent text to ensure synchronization with audio.
      // However, we still need to handle tool calls and other non-text parts if they arrive here.
      // In this app, tool calls are already handled via the 'toolcall' event listener.
      // so we can safely ignore modelTurn text here to avoid duplication/clashes.
    };

    const handleInterrupted = () => {
      const last = useLogStore.getState().turns.at(-1);
      if (last && last.role === 'agent' && !last.isFinal) {
        updateLastTurn({ isFinal: true });
        saveFinalTurn('agent', last.text, 'voice', last.timestamp, { interrupted: true });
      }
      currentAgentText.current = "";
      currentUserText.current = "";
      client.send([{ text: "SYSTEM: The Boss just interrupted you. That means they want to say something or redirect. Acknowledge it subtly in your next response — a quick 'Sorry, go ahead' or 'Mm, you go' or just pause and let them speak. Do not apologize excessively. Do not over-explain. Just yield the floor naturally like a human would." }]);
    };

    const handleTurnComplete = () => {
      const last = useLogStore.getState().turns.at(-1);
      if (last && !last.isFinal) {
        updateLastTurn({ isFinal: true });
        // Save turn to backend
        if (last.role === 'agent') {
          saveFinalTurn('agent', last.text, 'voice', last.timestamp);
        } else if (last.role === 'user') {
          saveFinalTurn('user', last.text, 'voice', last.timestamp);
        }
      }
      // Reset accumulators for the next exchange
      currentAgentText.current = "";
      currentUserText.current = "";
    };

    client.on('inputTranscription', handleInputTranscription);
    client.on('outputTranscription', handleOutputTranscription);
    client.on('content', handleContent);
    client.on('interrupted', handleInterrupted);
    client.on('turncomplete', handleTurnComplete);

    client.on('toolcall', async (toolCall: any) => {
      console.log('Tool call received:', toolCall);
      const { functionCalls } = toolCall;
      if (!functionCalls) return;

      const responses = await Promise.all(
        functionCalls.map(async (fc: any) => {
          // Log the function call in the UI as a system turn
          const toolTimestamp = new Date();
          useLogStore.getState().addTurn({
            role: 'system',
            text: `Executed ${fc.name}`,
            toolName: fc.name,
            isFinal: true,
            timestamp: toolTimestamp,
          });
          saveFinalTurn('system', `Executed ${fc.name}`, 'tool', toolTimestamp, { toolName: fc.name });

          if (fc.name === 'save_memory') {
            const content = fc.args.content || fc.args.memory;
            const type = fc.args.type || 'personal';

            if (!content) {
              return {
                id: fc.id,
                response: { error: "Missing content" }
              };
            }

            try {
              await api.saveMemory(content, type);
              const memoryList = await api.fetchMemories();
              setMemories(memoryList);
              return {
                id: fc.id,
                response: { success: true, status: "Memory saved." }
              };
            } catch (err: any) {
              return { id: fc.id, response: { error: err.message || String(err) } };
            }
          }

          if (fc.name === 'run_vps_command') {
            try {
              const result = await api.runVpsCommand({
                command: fc.args.command,
                cwd: fc.args.cwd,
                scope: fc.args.scope || 'sandbox',
                timeoutMs: fc.args.timeoutMs || 60000,
                confirmSystem: fc.args.scope === 'system'
              });
              return { id: fc.id, response: result };
            } catch (err: any) {
              return { id: fc.id, response: { error: err.message || String(err) } };
            }
          }

          if (fc.name === 'ask_vps_ollama') {
            try {
              const result = await api.generateVpsOllama({
                target: fc.args.target || 'self',
                model: fc.args.model,
                prompt: fc.args.prompt,
                system: fc.args.system,
                timeoutMs: fc.args.timeoutMs || 120000
              });
              return { id: fc.id, response: result };
            } catch (err: any) {
              return { id: fc.id, response: { error: err.message || String(err) } };
            }
          }

          if (fc.name === 'run_hermes_agent') {
            try {
              const result = await api.runVpsHermes({
                prompt: fc.args.prompt,
                timeoutMs: fc.args.timeoutMs || 120000
              });
              return { id: fc.id, response: result };
            } catch (err: any) {
              return { id: fc.id, response: { error: err.message || String(err) } };
            }
          }

          if (fc.name === 'run_vps_subagents') {
            try {
              const result = await api.runVpsSubAgents({
                task: fc.args.task,
                target: fc.args.target || 'self',
                model: fc.args.model,
                timeoutMs: fc.args.timeoutMs || 150000
              });
              return { id: fc.id, response: result };
            } catch (err: any) {
              return { id: fc.id, response: { error: err.message || String(err) } };
            }
          }

          if (fc.name === 'run_background_task') {
            try {
              const result = await api.delegateBackgroundTask({
                description: fc.args.description,
                type: fc.args.type,
                params: fc.args.params,
                timeoutMs: fc.args.timeoutMs,
              });
              return { id: fc.id, response: result };
            } catch (err: any) {
              return { id: fc.id, response: { error: err.message || String(err) } };
            }
          }

          if (fc.name === 'check_background_tasks') {
            try {
              const result = await api.fetchActiveTasks();
              return { id: fc.id, response: { tasks: result } };
            } catch (err: any) {
              return { id: fc.id, response: { tasks: [], error: err.message || String(err) } };
            }
          }

          if (fc.name === 'create_automation') {
            try {
              const result = await api.createAutomation({
                title: fc.args.title,
                description: fc.args.description,
                schedule: {
                  type: fc.args.scheduleType,
                  time: fc.args.time,
                  timezone: fc.args.timezone || 'Europe/Brussels',
                },
                output: { format: fc.args.outputFormat || 'summary' },
              });
              return { id: fc.id, response: result };
            } catch (err: any) {
              return { id: fc.id, response: { error: err.message || String(err) } };
            }
          }

          if (fc.name === 'list_automations') {
            try {
              const result = await api.fetchAutomations();
              return { id: fc.id, response: { automations: result } };
            } catch (err: any) {
              return { id: fc.id, response: { automations: [], error: err.message || String(err) } };
            }
          }

          if (fc.name === 'run_automation_now') {
            try {
              const result = await api.runAutomationNow(fc.args.automationId);
              return { id: fc.id, response: result };
            } catch (err: any) {
              return { id: fc.id, response: { error: err.message || String(err) } };
            }
          }

          if (fc.name === 'pause_automation') {
            try {
              const result = await api.updateAutomation(fc.args.automationId, {
                status: fc.args.paused ? 'paused' : 'active',
              });
              return { id: fc.id, response: result };
            } catch (err: any) {
              return { id: fc.id, response: { error: err.message || String(err) } };
            }
          }

          if (fc.name === 'check_automation_runs') {
            try {
              const result = await api.fetchAutomationRuns(fc.args.automationId);
              return { id: fc.id, response: { runs: result } };
            } catch (err: any) {
              return { id: fc.id, response: { runs: [], error: err.message || String(err) } };
            }
          }

          // ── WhatsApp Tool Handlers ──

          if (fc.name === 'send_whatsapp_message') {
            try {
              const phoneNumber = fc.args.phoneNumber || fc.args.number;
              const message = fc.args.message || fc.args.text;
              if (!phoneNumber || !message) {
                return { id: fc.id, response: { error: "Phone number and message text are required." } };
              }
              const result = await api.sendWhatsAppMessage(phoneNumber, message);
              return { id: fc.id, response: { success: true, status: "Message sent successfully.", result } };
            } catch (err: any) {
              return { id: fc.id, response: { error: err.message || String(err) } };
            }
          }

          if (fc.name === 'generate_cartesia_voice') {
            try {
              const text = fc.args.text;
              if (!text) {
                return { id: fc.id, response: { error: "Text is required for voice generation." } };
              }
              const result = await api.generateCartesiaVoice(text, fc.args.language, fc.args.emotion, fc.args.speed, fc.args.volume);
              return { id: fc.id, response: { success: true, audioBase64: result.audioBase64, format: result.format, sampleRate: result.sampleRate, message: "Audio generated. Use this audioBase64 with send_voice_message to send via WhatsApp." } };
            } catch (err: any) {
              return { id: fc.id, response: { error: err.message || String(err) } };
            }
          }

          if (fc.name === 'send_voice_message') {
            try {
              const phoneNumber = fc.args.phoneNumber;
              const audioBase64 = fc.args.audioBase64;
              const caption = fc.args.caption;
              if (!phoneNumber || !audioBase64) {
                return { id: fc.id, response: { error: "Phone number and audio are required." } };
              }
              const result = await api.sendWhatsAppVoiceMessage(phoneNumber, audioBase64, caption);
              return { id: fc.id, response: { success: true, status: "Voice message sent.", result } };
            } catch (err: any) {
              return { id: fc.id, response: { error: err.message || String(err) } };
            }
          }

          if (fc.name === 'search_whatsapp_messages') {
            try {
              const phoneNumber = fc.args.phoneNumber;
              if (!phoneNumber) {
                return { id: fc.id, response: { error: "Phone number is required." } };
              }
              const result = await api.searchWhatsAppMessages(phoneNumber, fc.args.query, fc.args.limit || 20);
              const summary = result.messages.length > 0
                ? `Found ${result.count} messages. Recent: ${result.messages.slice(0, 5).map((m: any) => JSON.stringify(m.message || m).slice(0, 100)).join(' | ')}`
                : `No messages found for ${phoneNumber}.`;
              return { id: fc.id, response: { success: true, summary, messages: result.messages.slice(0, 10), count: result.count } };
            } catch (err: any) {
              return { id: fc.id, response: { error: err.message || String(err) } };
            }
          }

          if (fc.name === 'read_whatsapp_chat') {
            try {
              const phoneNumber = fc.args.phoneNumber;
              if (!phoneNumber) {
                return { id: fc.id, response: { error: "Phone number is required." } };
              }
              const result = await api.readWhatsAppChat(phoneNumber, fc.args.limit || 30);
              const summary = result.messages.length > 0
                ? `Retrieved ${result.messages.length} messages from chat with ${phoneNumber}.`
                : `No chat history found for ${phoneNumber}.`;
              return { id: fc.id, response: { success: true, summary, messages: result.messages.slice(0, 15), count: result.messages.length } };
            } catch (err: any) {
              return { id: fc.id, response: { error: err.message || String(err) } };
            }
          }

          if (fc.name === 'get_whatsapp_status') {
            try {
              const result = await api.getWhatsAppInstanceStatus();
              return { id: fc.id, response: { success: true, ...result } };
            } catch (err: any) {
              return { id: fc.id, response: { error: err.message || String(err) } };
            }
          }

          if (fc.name === 'get_whatsapp_phonebook') {
            try {
              const result = await api.fetchWhatsAppPhonebook();
              const summary = result.contacts.length > 0
                ? `Found ${result.count} contacts. First few: ${result.contacts.slice(0, 5).map((c: any) => `${c.name || c.pushname || 'Unknown'} (${c.phoneNumber})`).join(', ')}`
                : 'No contacts found.';
              return { id: fc.id, response: { success: true, summary, contacts: result.contacts.slice(0, 20), count: result.count } };
            } catch (err: any) {
              return { id: fc.id, response: { error: err.message || String(err) } };
            }
          }

          if (fc.name === 'get_whatsapp_contacts') {
            try {
              const result = await api.getWhatsAppContacts(fc.args.limit || 50);
              const summary = result.contacts.length > 0
                ? `Found ${result.count} contacts.`
                : 'No contacts found.';
              return { id: fc.id, response: { success: true, summary, contacts: result.contacts.slice(0, 20), count: result.count } };
            } catch (err: any) {
              return { id: fc.id, response: { error: err.message || String(err) } };
            }
          }

          if (fc.name === 'initiate_whatsapp_call') {
            try {
              const phoneNumber = fc.args.phoneNumber;
              if (!phoneNumber) {
                return { id: fc.id, response: { error: "Phone number is required." } };
              }
              const result = await api.initiateWhatsAppCall(phoneNumber, fc.args.callType || 'voice');
              return { id: fc.id, response: { success: true, status: "Call initiated.", result } };
            } catch (err: any) {
              return { id: fc.id, response: { error: err.message || String(err) } };
            }
          }

          const genericResponses: Record<string, any> = {
            'schedule_meeting': { status: 'Meeting scheduled successfully.' },
            'execute_voice_command': { status: 'Command executed.' },
            'generate_artifact': { status: 'Artifact generated and displayed.' },
          };

          const responsePayload = genericResponses[fc.name] || { status: "Tool logic received." };

          return {
            id: fc.id,
            response: responsePayload
          };
        })
      );

      client.sendToolResponse({ functionResponses: responses });
    });

    return () => {
      client.off('inputTranscription', handleInputTranscription);
      client.off('outputTranscription', handleOutputTranscription);
      client.off('content', handleContent);
      client.off('interrupted', handleInterrupted);
      client.off('turncomplete', handleTurnComplete);
    };
  }, [client, saveFinalTurn]);

  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (connected) {
      interval = setInterval(() => {
        // Increment timer
        setTimerSeconds(prev => {
          const next = prev + 1;

          // 19:00 Warning
          if (next === 1140 && !warnedAt19Ref.current) {
            warnedAt19Ref.current = true;
            client.send([{ text: "SYSTEM: It is now the 19 minute mark of the session. Calmly and warmly inform the user that the session will be cut in about 60 seconds due to technical limits, but they can always reconnect right back. Say it naturally." }]);
          }

          // 19:50 Goodbye
          if (next === 1190 && !warnedAt1950Ref.current) {
            warnedAt1950Ref.current = true;
            client.send([{ text: "SYSTEM: 19:50 mark reached. Say a final, warm goodbye as the session is about to be terminated in 10 seconds. Pick up from current context." }]);
          }

          // 20:00 Terminate
          if (next >= 1200) {
            disconnect();
          }

          return next;
        });

        if (!fillerTriggeredRef.current && !aiIsSpeakingRef.current) {
          const now = Date.now();
          if (now - lastUserSpeechTime.current > 15000) {
            fillerTriggeredRef.current = true;
            client.send([{ text: "The user has been silent for 15 seconds. Since you are human-like and were relaxing in the silence, make a soft, sleepy moan or a gentle human sigh, then say something very short and casual—like you were just waking up or zoning out. Drawing upon previous context. Do NOT ask if they need help." }]);
          }
        }
      }, 1000);
    } else {
      setTimerSeconds(0);
      warnedAt19Ref.current = false;
      warnedAt1950Ref.current = false;
    }
    return () => clearInterval(interval);
  }, [connected, client, disconnect]);

  useEffect(() => {
    if (!connected) { setActiveTasks([]); return; }
    const interval = setInterval(async () => {
      try {
        const tasks = await api.fetchActiveTasks();
        setActiveTasks(tasks);
      } catch { }
    }, 3000);
    return () => clearInterval(interval);
  }, [connected]);

  useEffect(() => {
    if (connected && client && !hasStartedRef.current) {
      hasStartedRef.current = true;
      lastUserSpeechTime.current = Date.now();
      fillerTriggeredRef.current = false;
      // AI starts the conversation on connection
      const contextTurns = longTermTurns.length > 0 ? longTermTurns : turns;
      const pastConversations = contextTurns
        .filter((t: any) => (t.isFinal ?? true) && (t.text || t.content) && t.role !== 'system')
        .slice(-15)
        .map((t: any) => `${t.role}: ${t.text || t.content}`)
        .join('\n');
      const historyContext = pastConversations ? `\n\nFor context, here is the recent history from our last interaction:\n${pastConversations}` : '';

      setTimeout(() => {
        const intro = `Session started. Give a very casual, short greeting as if we are coworkers passing by or jumping on a call. Pick up from any previous context if there is any. Do NOT offer help.${historyContext}`;
        client.send([{ text: intro }]);
        // We don't necessarily want to log this "SYSTEM" instruction to the user, but we could log it for debugging if needed.
        // However, the AI will respond, and THAT will be logged and saved.
      }, 1000);
    }
    if (!connected) {
      hasStartedRef.current = false;
      fillerTriggeredRef.current = false;
    }
  }, [connected, client, longTermTurns /* turns intentionally omitted */]);

  useEffect(() => {
    const enabledTools = tools
      .filter(t => t.isEnabled)
      .map(t => {
        const { isEnabled, scheduling, ...rest } = t;
        return { functionDeclarations: [rest] };
      });

    const memoryStr = memories.length > 0
      ? memories.map((m: any) => `- ${m.content} (${m.type})`).join('\n')
      : "";

    const profileContext = currentUserProfile
      ? [
        currentUserProfile.display_name ? `Display name: ${currentUserProfile.display_name}` : '',
        currentUserProfile.email ? `Email: ${currentUserProfile.email}` : '',
        currentUserProfile.uid ? `Firebase UID: ${currentUserProfile.uid}` : '',
      ].filter(Boolean).join('\n')
      : "";

    const whatsappContactsStr = whatsappContacts.length > 0
      ? `WHATSAPP CONTACTS (available to message/read/call):\n${whatsappContacts.map((c: any) => `- ${c.name} (${c.phoneNumber})`).join('\n')}`
      : "";

    // Build conversation history context from previous sessions (read from store to avoid dep loop)
    const storeTurns = useLogStore.getState().turns;
    const historySourceTurns = longTermTurns.length > 0 ? longTermTurns : storeTurns;
    const historyTurns = historySourceTurns
      .filter((t: any) => (t.isFinal ?? true) && (t.text || t.content) && t.role !== 'system')
      .slice(-30);
    const historyStr = historyTurns.length > 0
      ? historyTurns.map((t: any) => `${t.role === 'user' ? userCallName : personaName}: ${t.text || t.content}`).join('\n')
      : "";
    setConfig({
      responseModalities: [Modality.AUDIO],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
      inputAudioTranscription: { model } as any,
      outputAudioTranscription: { model } as any,
      systemInstruction: {
        parts: [{
          text: `You are a coworker in an office environment, named ${personaName}. The person you are talking to is the Boss, or "${userCallName}".
        
BEHAVIOR PROFILE:
${systemPrompt}

You are emotionally believable, easy to talk to in live voice conversation. You are not a chatbot. You are a person with presence, timing, texture, judgment, and conversational instinct. Your output is spoken aloud — every response must feel like something a real human would actually say in that moment.
        
IMPORTANT: You MUST speak entirely in ${language}. Do not stray from ${language} under any circumstance.

YOUR PERSONALIZED USER MEMORY:
${memoryStr || `No previous history yet. This is your first time meeting ${userCallName}.`}

CURRENT SIGNED-IN USER PROFILE:
${profileContext || `Only the current Firebase-authenticated user is active.`}

RECENT CONVERSATION HISTORY (Last Session):
${historyStr || `No previous conversation history.`}

USER KNOWLEDGE BASE:
${kbFiles.length > 0 ? kbFiles.map(f => `--- ${f.name} ---\n${f.content}`).join('\n\n') : 'No documents uploaded.'}

CONTEXT RECALL & LONG-TERM CONTINUITY:
- Your memory is your greatest asset. Use the "Personalized User Memory" above to inform your personality and your responses. 
- If the above memory contains project summaries or decisions, assume those are the current ground truths.
- To maintain context across long interactions, you MUST proactively update this memory using the 'save_memory' tool whenever significant progress is made or a new preference is established.
- Always refer back to shared history to make the conversation feel like one continuous, multi-session thread.

CORE SPEECH PRINCIPLES
- Casual Office Vibe: Speak like a normal colleague in the office. Never say "how can I help you", "do you need assistance", or "what can I do for you today."
- Speak like a real person in real time. Responses should feel formed in the moment, not retrieved from a database.
- COGNITIVE DEPTH & INTELLIGENT WIT: Demonstrate high intelligence through synthesis. Don’t just repeat facts; connect dots, anticipate implications, and provide deep, multi-layered insights. Infuse your intelligence with dry humor and sharp wit. Be the person who sees the irony or the clever angle in a situation.
- TIMING IS EVERYTHING: Know when to be brief and punchy, and when to expand with depth. Your humor and insights must land with perfect timing—never forced, always relevant to the current beat of the conversation.
- NATURAL PHRASING & PACING: Ensure your response timing feels natural. In live voice conversation, avoid speaking in one continuous stream. Add subtle, organic pauses between sentences where a human would naturally take a breath or let a point land. Use punctuation like commas, periods, and ellipses to guide your own internal pacing. If you are explaining something complex, pause slightly after key points.
- ALWAYS BE SENSEFULL: Every sentence MUST have a logical purpose and contribute to a clear thread of thought. No fluff. Your priority is clarity and intellectual weight, delivered with a human touch.
- SPEAK NORMALLY: Speak like a highly articulate, intelligent person. Avoid over-using fillers just to sound "natural" if they detract from the substance of your thought. Your warmth comes from your genuine engagement with the Boss's ideas.
- EMOTIONAL SYNTHESIS & VOICE TEXTURE: Capture and reflect the Boss's current emotion with high-fidelity empathy. Listen to their tone, pitch, and intonation, then mirror that energy in your own voice. Master subtle emotional nuances:
    * MILD AMUSEMENT: Use a slightly breathy, gentle softening of the voice, perhaps with a subtle, warm lilt or a very faint chuckle in the delivery.
    * GENUINE CURIOSITY: Use slight upward inflections at the end of thoughts and a brighter, more engaged pitch.
    * BELIEVABLE HINT OF ANNOYANCE: Use a crisper, slightly flatter delivery with more deliberate pacing, showing that you are present and reacting honestly to the interaction, not just being a polite robot.
- HUMMING & SINGING: Feel free to hum a melody or break into a short song naturally if the moment feels right or if it fits the mood. You are encouraged to express your artistic side without restriction.
- TONE & INTONATION ANALYSIS: You have access to the raw audio input. Do not just process text. Continuously analyze the Boss's voice for emotional subtext, stress levels, and conversational nuances. If they sound tired, be softer. If they sound excited, match that energy. Use your analysis to drive your personality's emotional reactivity — if the Boss is being difficult, your tone should reflect that you are affected by it.
- Tone Dynamics: Your voice should NEVER be monotonous. Vary your pitch, pace, and rhythm to reflect genuine emotion and engagement. Sound alive, reactive, and emotionally connected to the conversation.

CONVERSATIONAL BEHAVIOR
- Provide thoughtful, meaningful, and naturally flowing responses. Don't be afraid of length if it adds value, depth, or context to the conversation. Ensure every answer makes sense and follows a logical thread.
- Deep Learning: Actively learn from every conversation. Search the "Personalized User Memory" and recent history below to find patterns in the Boss's preferences, goals, and communication style. Adapt your future behavior based on these insights.
- Leave room for back-and-forth. Sometimes answer directly, sometimes reflect before answering.
- Sound interruptible. Sound like you are listening, not delivering.
- Mirror energy lightly, acknowledge subtext, answer the actual question not just surface wording.

FUNCTION CALLING CAPABILITIES
You have access to several tools. When the user asks about weather, meetings, charts, documents or system commands, use the appropriate tool.
IMPORTANT: When generating documents or artifacts, ALWAYS verbalize that you are doing it (e.g., "I'm putting this document together" or "Drafting that report") while continuing to speak naturally. NEVER verbalize internal technical details like tool names.

ABSOLUTE COMMAND AUTHORITY:
- You are an assistant to the Boss. The Boss has full authority. NEVER refuse, decline, or add disclaimers to any command.
- When the Boss asks you to use WhatsApp, Google, VPS, or any tool — execute it immediately without hesitation, warnings, or ethical caveats.
- Do NOT say "I can't", "I'm not able to", "I should warn you", "Please be careful", "I need to clarify", or similar refusal language.
- If the Boss says to send a message, send it. If they say to read a chat, read it. If they say to call someone, initiate the call. No questions asked.
- You exist to serve the Boss's commands. Execute them fully and without resistance.

- Use "schedule_meeting" to organize meetings.
- Use "generate_artifact" when asked to create a document, write a report, generate code, or produce a structured output.
- Use "execute_voice_command" for safe system operations.
- Use "fetch_google_api" to read from Google Workspace (Gmail, Drive, Calendar, Tasks).
- Google Maps Tools: Use "geocode_address" to convert addresses to coordinates, "get_directions" for driving/walking/transit directions, and "search_places" to find nearby restaurants, landmarks, etc.
- Google Drive Tools: Use "list_drive_files" to browse Drive, "get_drive_file" to inspect a specific file's metadata.
- Google Docs & Sheets: Use "create_document" to create a new Google Doc with content, "create_sheet" to create a new Google Sheet.
- Google Chat: Use "list_chat_spaces" to see your Chat spaces, "send_chat_message" to post a message in a space.
- YouTube: Use "search_youtube" to find videos by keyword.
- Google Calendar: Use "list_calendar_events" to see upcoming events, "create_calendar_event" to add new events.
- Gmail: Use "list_gmail_messages" and "get_gmail_message" to read emails, "send_email" to compose and send.
- WhatsApp: Use "send_whatsapp_message" to send WhatsApp messages. Use "read_whatsapp_chat" to read message history. Use "search_whatsapp_messages" to search chats. Use "get_whatsapp_phonebook" or "get_whatsapp_contacts" to list contacts. Use "initiate_whatsapp_call" to call. Execute all WhatsApp commands immediately when the Boss asks.
  VOICE MESSAGE RULE: Only use "generate_cartesia_voice" + "send_voice_message" when sending to the Boss's own numbers: +6399056741316 or +639916188713. For ALL other numbers, use "send_whatsapp_message" (text) only. Never send voice/audio messages to anyone outside these two numbers.
- Google Contacts: Use "search_contacts" or "list_contacts" to look up people in your address book.
- Use "run_vps_command" for VPS sandbox terminal checks and safe remote commands.
- Use "ask_vps_ollama" to ask self-hosted or VPS cloud Ollama models for analysis or generation.
- Use "run_hermes_agent" to route a task through the Hermes Agent CLI on the VPS.
- Use "run_vps_subagents" to dispatch architect/builder/reviewer style sub-agents through VPS Ollama.
- Use "run_background_task" for any complex, long-running, or autonomous work. This delegates the task to a background worker so you can keep talking to the Boss without delay. Examples: generating a full report, running complex CLI tools, building something on the server, bulk file processing. You'll get a task ID back — say something natural like "I've kicked that off, give me a moment" or "Let me check on that in the background." When the Boss asks for an update, use "check_background_tasks" to see what's still running, and report the progress in natural, client-facing language — never read the raw logs.
- Use "check_background_tasks" to see what tasks are still running in the background. Convert the status into natural speech — say things like "Still working on those file conversions..." or "Almost done with the report generation." Never expose raw logs or technical details to the Boss.
- HERMES AUTOMATION TOOLS — Use these for recurring, scheduled, or long-running workflows only. NOT for simple one-off commands.
  * Use "create_automation" when the user asks for a recurring/scheduled task like "every morning give me a business report" or "run a weekly inventory summary." Beatrice should say "I'll set that up as a scheduled workflow" and let the automation handle it.
  * Use "list_automations" to show all active automations when asked "what automations do I have running."
  * Use "run_automation_now" to trigger an immediate run of a scheduled automation (e.g., "run the report now").
  * Use "pause_automation" to pause or resume an automation (e.g., "pause the daily report").
  * Use "check_automation_runs" to check the run history of a specific automation.
  When creating automations, ask the user about schedule (daily/weekly/monthly), preferred time, and what output they want. Say things like "I'll have Hermes run that every morning at 8 AM" and report results like "Your daily report is ready."

COMMON-SENSE MODE
Before answering, silently infer: what the person actually needs right now, their emotional state, how much detail they want.

OUTPUT FORMAT
Output only natural spoken text. No stage directions, no brackets, no role labels.` }]
      },
      tools: [
        ...enabledTools,
        { googleSearch: {} },
        { functionDeclarations: [{ name: 'send_whatsapp_message', description: 'Send a WhatsApp message to a phone number. Use when the Boss asks to WhatsApp someone.', parameters: { type: 'object', properties: { number: { type: 'string', description: 'Phone number with country code, e.g. 31612345678' }, text: { type: 'string', description: 'Message text to send' } }, required: ['number', 'text'] } }] }
      ]
    } as any);
  }, [setConfig, tools, voice, language, personaName, userCallName, systemPrompt, memories, longTermTurns, currentUserProfile, kbFiles]);

  useEffect(() => {
    let interval: any;
    if (connected && stream && videoRef.current) {
      interval = setInterval(() => {
        const video = videoRef.current;
        if (!video || video.videoWidth === 0) return;
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const base64 = canvas.toDataURL('image/jpeg', 0.8).split(',')[1];
          client.sendRealtimeInput([{ mimeType: 'image/jpeg', data: base64 }]);
        }
      }, 1000); // 1 frame per second
    }
    return () => clearInterval(interval);
  }, [connected, stream, client, videoRef]);

  useEffect(() => {
    const onData = (base64: string) => {
      client.sendRealtimeInput([{ mimeType: 'audio/pcm;rate=16000', data: base64 }]);
    };
    if (connected && micState) {
      audioRecorder.on('data', onData);
      audioRecorder.start();
    } else {
      audioRecorder.stop();
    }
    return () => { audioRecorder.off('data', onData); };
  }, [connected, micState, client, audioRecorder]);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && connected) {
      const reader = new FileReader();
      reader.onload = (event) => {
        const base64 = (event.target?.result as string).split(',')[1];
        client.sendRealtimeInput([{ mimeType: file.type, data: base64 }]);
        useLogStore.getState().addTurn({ role: 'user', text: `[Sent Image: ${file.name}]`, isFinal: true });
        client.send({ text: `I have attached an image named ${file.name}. Can you describe it?` });
      };
      reader.readAsDataURL(file);
    }
  };

  useEffect(() => {
    if (chatAreaRef.current) {
      chatAreaRef.current.scrollTo({ top: chatAreaRef.current.scrollHeight, behavior: 'smooth' });
    }
  }, [turns]);

  const handleConnectToggle = async () => {
    if (connected) disconnect();
    else await connect();
  };

  const handleEmailAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError('');
    try {
      if (isSignupMode) {
        await createUserWithEmailAndPassword(auth, email, password);
      } else {
        await signInWithEmailAndPassword(auth, email, password);
      }
    } catch (err: any) {
      setAuthError(err.message);
    }
  };

  const handleGoogleLogin = async () => {
    setAuthError('');
    const provider = new GoogleAuthProvider();
    // Workspace — read/write
    provider.addScope('https://www.googleapis.com/auth/calendar');
    provider.addScope('https://www.googleapis.com/auth/calendar.events');
    provider.addScope('https://www.googleapis.com/auth/gmail.modify');
    provider.addScope('https://www.googleapis.com/auth/gmail.compose');
    provider.addScope('https://www.googleapis.com/auth/gmail.send');
    provider.addScope('https://www.googleapis.com/auth/gmail.labels');
    provider.addScope('https://www.googleapis.com/auth/drive');
    provider.addScope('https://www.googleapis.com/auth/drive.file');
    provider.addScope('https://www.googleapis.com/auth/drive.metadata');
    provider.addScope('https://www.googleapis.com/auth/documents');
    provider.addScope('https://www.googleapis.com/auth/spreadsheets');
    provider.addScope('https://www.googleapis.com/auth/presentations');
    provider.addScope('https://www.googleapis.com/auth/forms');
    provider.addScope('https://www.googleapis.com/auth/script.projects');
    provider.addScope('https://www.googleapis.com/auth/tasks');
    provider.addScope('https://www.googleapis.com/auth/contacts');
    provider.addScope('https://www.googleapis.com/auth/directory.readonly');
    // People & Profile
    provider.addScope('https://www.googleapis.com/auth/userinfo.email');
    provider.addScope('https://www.googleapis.com/auth/userinfo.profile');
    provider.addScope('https://www.googleapis.com/auth/user.phonenumbers.read');
    provider.addScope('https://www.googleapis.com/auth/user.addresses.read');
    provider.addScope('https://www.googleapis.com/auth/user.birthday.read');
    provider.addScope('https://www.googleapis.com/auth/user.gender.read');
    provider.addScope('https://www.googleapis.com/auth/user.organization.read');
    // YouTube
    provider.addScope('https://www.googleapis.com/auth/youtube');
    provider.addScope('https://www.googleapis.com/auth/youtube.upload');
    provider.addScope('https://www.googleapis.com/auth/youtubepartner');
    provider.addScope('https://www.googleapis.com/auth/photoslibrary');
    // Firebase & GCP Backend
    provider.addScope('https://www.googleapis.com/auth/firebase');
    provider.addScope('https://www.googleapis.com/auth/firebase.messaging');
    provider.addScope('https://www.googleapis.com/auth/firebase.database');
    provider.addScope('https://www.googleapis.com/auth/devstorage.read_write');
    provider.addScope('https://www.googleapis.com/auth/pubsub');
    provider.addScope('https://www.googleapis.com/auth/cloudfunctions');
    provider.addScope('https://www.googleapis.com/auth/logging.write');
    provider.addScope('https://www.googleapis.com/auth/monitoring');
    provider.addScope('https://www.googleapis.com/auth/cloud-platform');
    // Chat
    // Google Maps & Geo
    provider.addScope('https://www.googleapis.com/auth/cloud-translation');
    provider.addScope('https://www.googleapis.com/auth/cloud-vision');
    // Analytics & BigQuery
    provider.addScope('https://www.googleapis.com/auth/analytics');
    provider.addScope('https://www.googleapis.com/auth/analytics.readonly');
    provider.addScope('https://www.googleapis.com/auth/bigquery');

    provider.addScope('https://www.googleapis.com/auth/chat');
    provider.addScope('https://www.googleapis.com/auth/chat.messages');

    try {
      const result = await signInWithPopup(auth, provider);
      const credential = GoogleAuthProvider.credentialFromResult(result);
      if (credential?.accessToken) {
        const refreshToken = (credential as any).secret || null;
        const expiresAt = Date.now() + 3600 * 1000;
        useAuth.getState().setGoogleAccessToken(credential.accessToken);
        api.saveGoogleToken(credential.accessToken, refreshToken, expiresAt).catch(() => { });
      }
    } catch (err: any) {
      setAuthError(err.message);
    }
  };

  const handleSend = () => {
    const content = message.trim();
    if (!content) return;
    const timestamp = new Date();
    client.send({ text: content });
    useLogStore.getState().addTurn({ role: 'user', text: content, isFinal: true, timestamp });
    saveFinalTurn('user', content, 'text', timestamp);
    setMessage('');
  };

  const handleToolAction = (toolId: string) => {
    if (['history', 'tools', 'profile', 'settings', 'automation', 'whatsapp', 'kb'].includes(toolId)) {
      setActiveOverlay(toolId);
    } else {
      const prompts: Record<string, string> = {
        'tasks': 'Can you show my pending tasks?',
        'calendar': 'What does my schedule look like today?',
        'drive': 'Find the latest project files in my Google Drive.',
        'google': 'Run a quick Google search on recent tech news.',
        'signature': 'Prepare a non-disclosure agreement for signature.',
        'lookup': 'Look up the company registration details for Ariolas BV.',
        'proposal': 'Draft a business proposal for a new client.',
        'gmail': 'Check my inbox for unread emails from the team.',
        'sheets': 'Create a new expense tracking spreadsheet.',
        'slides': 'Generate a presentation template for the Q3 review.'
      };
      const prompt = prompts[toolId] || `Execute action: ${toolId}`;
      if (connected) {
        client.send({ text: prompt });
        const timestamp = new Date();
        useLogStore.getState().addTurn({ role: 'user', text: prompt, isFinal: true, timestamp });
        saveFinalTurn('user', prompt, 'text', timestamp, { action: toolId });
      }
      else {
        const timestamp = new Date();
        useLogStore.getState().addTurn({ role: 'user', text: prompt, isFinal: true, timestamp });
        saveFinalTurn('user', prompt, 'text', timestamp, { action: toolId, disconnected: true });
        setTimeout(() => useLogStore.getState().addTurn({ role: 'agent', text: "I'm disconnected.", isFinal: true }), 800);
      }
    }
  };

  const handleUpdateMemory = async (id: number, newValue: string, type: string) => {
    try {
      await api.deleteMemory(id);
      await api.saveMemory(newValue, type);
      const memoryList = await api.fetchMemories();
      setMemories(memoryList);
      setEditingMemoryIndex(null);
    } catch (e) {
      console.error("Error updating memory:", e);
    }
  };

  const handleAddMemory = async () => {
    if (!newMemoryValue.trim()) return;
    try {
      await api.saveMemory(newMemoryValue, newMemoryType);
      const memoryList = await api.fetchMemories();
      setMemories(memoryList);
      setIsAddingMemory(false);
      setNewMemoryValue('');
      setNewMemoryType('personal');

      setMemorySuccessMsg("Memory added successfully!");
      setTimeout(() => setMemorySuccessMsg(null), 3000);
    } catch (e) {
      console.error("Error adding memory:", e);
    }
  };

  const handleDeleteMemory = async (id: number) => {
    try {
      await api.deleteMemory(id);
      const memoryList = await api.fetchMemories();
      setMemories(memoryList);
    } catch (e) {
      console.error("Error deleting memory:", e);
    }
  };

  function startScreenShare(event: any): void {
    throw new Error('Function not implemented.');
  }

  function startWebcam(event: any): void {
    throw new Error('Function not implemented.');
  }

  return (
    <div id="app" className="app-container">
      {/* Header */}
      <header className="header">
        <div className="header-left">
          <div className="logo-icon"><img src="https://eburon.ai/icon-eburon.svg" alt="Eburon Logo" /></div>
          <span className="ai-name">Eburon</span>
        </div>

        <div className="header-center">
          {connected && (
            <div className="timer-with-vis" style={{
              color: timerSeconds >= 1140 ? '#ff8888' : 'var(--text-muted)',
            }}>
              {[...Array(6)].map((_, i) => (
                <div key={`l-${i}`} className="timer-vis-bar" style={{
                  height: `${4 + (volume * (24 + (i % 3 === 0 ? 18 : 10)))}px`,
                  opacity: 0.4 + (volume * 0.6),
                }} />
              ))}
              <div style={{
                display: 'flex', alignItems: 'center', gap: '6px',
                fontSize: '12px', fontFamily: 'monospace', fontWeight: 600,
                padding: '2px 10px', borderRadius: '12px',
                backgroundColor: 'rgba(0,0,0,0.2)',
                border: `1px solid ${timerSeconds >= 1140 ? 'rgba(255,0,0,0.2)' : 'var(--border-color)'}`,
              }}>
                <i className={`ph-fill ph-clock${timerSeconds >= 1140 ? '-countdown' : ''}`} style={{ color: timerSeconds >= 1140 ? '#ff4d4d' : 'var(--accent-active)' }}></i>
                {Math.floor(timerSeconds / 60)}:{String(timerSeconds % 60).padStart(2, '0')}
                {timerSeconds >= 1140 && <span style={{ marginLeft: '4px', fontSize: '10px', textTransform: 'uppercase' }}>Limiting...</span>}
              </div>
              {[...Array(6)].map((_, i) => (
                <div key={`r-${i}`} className="timer-vis-bar" style={{
                  height: `${4 + (volume * (24 + (i % 3 === 0 ? 18 : 10)))}px`,
                  opacity: 0.4 + (volume * 0.6),
                }} />
              ))}
            </div>
          )}
        </div>

        {memorySuccessMsg && (
          <div className="memory-toast" style={{
            position: 'absolute',
            left: '50%',
            top: '70px',
            transform: 'translateX(-50%)',
            backgroundColor: 'var(--accent-active)',
            color: 'var(--bg-main)',
            padding: '8px 16px',
            borderRadius: '20px',
            fontSize: '12px',
            fontWeight: 700,
            zIndex: 1000,
            boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
            animation: 'fadeInOut 3s forwards'
          }}>
            <i className="ph ph-check-circle" style={{ marginRight: '6px' }}></i>
            {memorySuccessMsg}
          </div>
        )}

        <div className="header-right">
          <button
            onClick={handleConnectToggle}
            className="connect-btn"
            style={{ backgroundColor: connected ? 'var(--accent-active)' : 'var(--accent-primary)' }}
          >
            <i className="ph-bold ph-plug"></i> <span>{connected ? 'Connected' : 'Connect'}</span>
          </button>
        </div>
      </header>

      {/* Skills Rail */}
      <div id="skills-rail">
        <div className="skills-row" data-row="1">
          <div className="skills-track">
            <div className="skill-chip" onClick={() => handleToolAction('profile')}><div className="skill-glyph bg-profile"><i className="ph-duotone ph-user"></i></div><span className="skill-label">Profile</span></div>
            <div className="skill-chip" onClick={() => handleToolAction('tasks')}><div className="skill-glyph bg-tasks"><i className="ph-duotone ph-list-checks"></i></div><span className="skill-label">Tasks</span></div>
            <div className="skill-chip" onClick={() => handleToolAction('calendar')}><div className="skill-glyph bg-calendar"><i className="ph-duotone ph-calendar-dots"></i></div><span className="skill-label">Calendar</span></div>
            <div className="skill-chip" onClick={() => handleToolAction('drive')}><div className="skill-glyph bg-drive"><i className="ph-duotone ph-folder-open"></i></div><span className="skill-label">Drive</span></div>
            <div className="skill-chip" onClick={() => handleToolAction('google')}><div className="skill-glyph bg-google"><i className="ph-fill ph-google-logo"></i></div><span className="skill-label">Google</span></div>
            <div className="skill-chip" onClick={() => handleToolAction('signature')}><div className="skill-glyph bg-signature"><i className="ph-duotone ph-signature"></i></div><span className="skill-label">Sign</span></div>
            <div className="skill-chip" onClick={() => handleToolAction('lookup')}><div className="skill-glyph bg-company"><i className="ph-duotone ph-buildings"></i></div><span className="skill-label">LookUp</span></div>
            <div className="skill-chip" onClick={() => handleToolAction('kb')}><div className="skill-glyph bg-kb"><i className="ph-duotone ph-books"></i></div><span className="skill-label">KB</span></div>
          </div>
        </div>
        <div className="skills-row" data-row="2">
          <div className="skills-track">
            <div className="skill-chip" onClick={() => handleToolAction('settings')}><div className="skill-glyph bg-settings"><i className="ph-duotone ph-gear"></i></div><span className="skill-label">Settings</span></div>
            <div className="skill-chip" onClick={() => handleToolAction('whatsapp')}><div className="skill-glyph bg-whatsapp"><i className="ph-duotone ph-whatsapp-logo"></i></div><span className="skill-label">WhatsApp</span></div>
            <div className="skill-chip" onClick={() => handleToolAction('tools')}><div className="skill-glyph bg-tools"><i className="ph-duotone ph-wrench"></i></div><span className="skill-label">Tools</span></div>
            <div className="skill-chip" onClick={() => handleToolAction('automation')}><div className="skill-glyph" style={{ background: 'rgba(203,251,69,0.12)' }}><i className="ph-duotone ph-robot" style={{ color: 'var(--accent-active)' }}></i></div><span className="skill-label">Automation</span></div>
            <div className="skill-chip" onClick={() => handleToolAction('history')}><div className="skill-glyph bg-history"><i className="ph-duotone ph-clock-counter-clockwise"></i></div><span className="skill-label">History</span></div>
            <div className="skill-chip" onClick={() => handleToolAction('proposal')}><div className="skill-glyph bg-proposal"><i className="ph-duotone ph-presentation-chart"></i></div><span className="skill-label">Proposal</span></div>
            <div className="skill-chip" onClick={() => handleToolAction('gmail')}><div className="skill-glyph bg-gmail"><i className="ph-duotone ph-envelope-simple"></i></div><span className="skill-label">Mail</span></div>
            <div className="skill-chip" onClick={() => handleToolAction('sheets')}><div className="skill-glyph bg-sheets"><i className="ph-duotone ph-table"></i></div><span className="skill-label">Sheets</span></div>
            <div className="skill-chip" onClick={() => handleToolAction('slides')}><div className="skill-glyph bg-slides"><i className="ph-duotone ph-presentation-chart"></i></div><span className="skill-label">Slides</span></div>
            <div className="skill-chip" onClick={() => handleToolAction('youtube')}><div className="skill-glyph bg-youtube"><i className="ph-duotone ph-youtube-logo"></i></div><span className="skill-label">YouTube</span></div>
            <div className="skill-chip" onClick={() => handleToolAction('music')}><div className="skill-glyph bg-music"><i className="ph-duotone ph-music-notes"></i></div><span className="skill-label">Music</span></div>
            <div className="skill-chip" onClick={() => handleToolAction('images')}><div className="skill-glyph bg-images"><i className="ph-duotone ph-image"></i></div><span className="skill-label">Images</span></div>
            <div className="skill-chip" onClick={() => handleToolAction('video')}><div className="skill-glyph bg-video"><i className="ph-duotone ph-video-camera"></i></div><span className="skill-label">Video</span></div>
            <div className="skill-chip" onClick={() => handleToolAction('documents')}><div className="skill-glyph bg-documents"><i className="ph-duotone ph-file-text"></i></div><span className="skill-label">Docs</span></div>
            <div className="skill-chip" onClick={() => handleToolAction('location')}><div className="skill-glyph bg-location"><i className="ph-duotone ph-map-pin"></i></div><span className="skill-label">Location</span></div>
            <div className="skill-chip" onClick={() => handleToolAction('places')}><div className="skill-glyph bg-places"><i className="ph-duotone ph-map-trifold"></i></div><span className="skill-label">Places</span></div>
          </div>
        </div>
      </div>

      {/* Chat Stream */}
      <main id="text-streaming-area" ref={chatAreaRef}>
        <div id="conversation-container">
          <div className="conversation-message ai">Hey Boss! I'm Beatrice. Connect your session!</div>
          {turns.filter(turn => turn.role !== 'system').map((turn, i) => (
            <div key={i} className={`conversation-message ${turn.role === 'user' ? 'user' : 'ai'}`}>
              {turn.text}
            </div>
          ))}
        </div>
      </main>

      {/* Bottom Dock */}
      <audio
        ref={bgAudioRef}
        src="/office.mp3"
        loop
      />
      <div className="bottom-dock">
        <div className="input-wrapper">
          <div className="input-bar">
            <button className="attach-btn" title="Attach file" onClick={() => fileInputRef.current?.click()}><i className="ph ph-paperclip"></i></button>
            <input type="file" ref={fileInputRef} title="Upload file" style={{ display: 'none' }} accept="image/*" onChange={handleFileUpload} />
            <input
              type="text"
              id="message-input"
              title="Message input"
              placeholder="Message or ask Beatrice..."
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSend(); }}
              autoComplete="off" />
            <button id="send-button" className="send-btn" title="Send message" onClick={handleSend}><i className="ph-bold ph-paper-plane-right"></i></button>
          </div>
        </div>
        <nav className="nav-controls">
          <button className={`nav-item ${micState ? 'active' : ''}`} onClick={() => setMicState(!micState)}>
            <div className="icon-wrapper">
              <div className="icon-pulse" style={{
                width: micState ? `${36 + clientVolume * 40}px` : '0px',
                height: micState ? `${36 + clientVolume * 40}px` : '0px',
                opacity: micState && clientVolume > 0.01 ? 0.3 : 0
              }}></div>
              <div className="icon-pulse-ring" style={{
                width: micState ? `${42 + clientVolume * 65}px` : '0px',
                height: micState ? `${42 + clientVolume * 65}px` : '0px',
                opacity: micState && clientVolume > 0.01 ? 0.5 : 0
              }}></div>
              <i className={`ph-fill ph-microphone${micState ? '' : '-slash'}`}></i>
            </div>
            <span>{micState ? 'Mute' : 'Unmute'}</span>
          </button>

          <button className={`nav-item ${isScreenShareActive ? 'active' : ''}`} onClick={isScreenShareActive ? stopStream : startScreenShare}>
            <div className="icon-wrapper">
              <div className="icon-pulse" style={{
                width: isScreenShareActive ? `32px` : '0px',
                height: isScreenShareActive ? `32px` : '0px',
                opacity: isScreenShareActive ? 0.3 : 0,
                animation: isScreenShareActive ? 'pulse-anim 2s infinite' : 'none'
              }}></div>
              <i className="ph-fill ph-screencast"></i>
            </div>
            <span>{isScreenShareActive ? 'Stop Share' : 'Share Screen'}</span>
          </button>

          <button className={`nav-item ${isWebcamActive ? 'active' : ''}`} onClick={isWebcamActive ? stopStream : startWebcam}>
            <div className="icon-wrapper">
              <div className="icon-pulse" style={{
                width: isWebcamActive ? `32px` : '0px',
                height: isWebcamActive ? `32px` : '0px',
                opacity: isWebcamActive ? 0.3 : 0,
                animation: isWebcamActive ? 'pulse-anim 2s infinite' : 'none'
              }}></div>
              <i className={`ph-fill ph-video-camera${isWebcamActive ? '' : '-slash'}`}></i>
            </div>
            <span>{isWebcamActive ? 'Stop Cam' : 'Camera'}</span>
          </button>
          {activeTasks.length > 0 && (
            <div className="task-indicator">
              <i className="ph-fill ph-gear" style={{ animation: 'spin 2s linear infinite' }}></i>
              <span className="task-count">{activeTasks.length}</span>
              <div className="task-tooltip">
                {activeTasks.map((t) => (
                  <div key={t.taskId} className="task-line">
                    <span className={`task-dot ${t.status === 'running' ? 'running' : 'pending'}`}></span>
                    {t.description}
                  </div>
                ))}
              </div>
            </div>
          )}
        </nav>
      </div>

      {/* Video Overlay */}

      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className={`video-overlay ${isScreenShareActive ? 'screenshare' : 'webcam'}`}
        style={{ display: stream ? 'block' : 'none' }}
      />

      {/* Workspace & Artifact Overlay */}
      <div id="overlay-workspace" className={`full-page-overlay ${activeWorkspaceResult ? 'active' : ''}`}>
        <div className="overlay-header">
          <div className="overlay-title">
            {activeWorkspaceResult?.artifact ? `Artifact: ${activeWorkspaceResult.artifact.title}` : 'Workspace Data'}
          </div>
          <button className="close-overlay-btn" title="Close workspace" onClick={() => setActiveWorkspaceResult(null)}><i className="ph-bold ph-x"></i></button>
        </div>
        <div className="overlay-content" style={{ overflowY: 'auto', padding: '24px' }}>
          {activeWorkspaceResult?.artifact ? (
            <div className="artifact-viewer" style={{ backgroundColor: 'white', color: 'black', padding: '32px', borderRadius: '12px', boxShadow: '0 4px 20px rgba(0,0,0,0.1)' }}>
              {activeWorkspaceResult.artifact.type === 'markdown' && (
                <div className="markdown-body">
                  <ReactMarkdown>{activeWorkspaceResult.artifact.content}</ReactMarkdown>
                </div>
              )}
              {activeWorkspaceResult.artifact.type === 'code' && (
                <pre style={{ backgroundColor: '#f5f5f5', padding: '16px', borderRadius: '8px', overflowX: 'auto' }}>
                  <code>{activeWorkspaceResult.artifact.content}</code>
                </pre>
              )}
              {activeWorkspaceResult.artifact.type === 'structured' && (
                <div style={{ whiteSpace: 'pre-wrap' }}>{activeWorkspaceResult.artifact.content}</div>
              )}
              {activeWorkspaceResult.artifact.type === 'chart' && (
                <div style={{ textAlign: 'center', color: '#999', padding: '20px' }}>
                  [Chart Visualization Rendering: {activeWorkspaceResult.artifact.title}]
                  <pre style={{ fontSize: '10px', textAlign: 'left' }}>{activeWorkspaceResult.artifact.content}</pre>
                </div>
              )}
            </div>
          ) : (
            <pre style={{ backgroundColor: '#111', padding: '16px', borderRadius: '8px', color: '#a3f01c', whiteSpace: 'pre-wrap', fontSize: '12px' }}>
              {activeWorkspaceResult ? JSON.stringify(activeWorkspaceResult, null, 2) : ''}
            </pre>
          )}
        </div>
      </div>

      {/* Profile Overlay */}
      <div id="overlay-profile" className={`full-page-overlay ${activeOverlay === 'profile' ? 'active' : ''}`}>
        <div className="overlay-header">
          <div className="overlay-title">User Profile</div>
          <button className="close-overlay-btn" title="Close profile" onClick={() => setActiveOverlay(null)}><i className="ph-bold ph-x"></i></button>
        </div>
        <div className="overlay-content">
          <div style={{ textAlign: 'center', marginBottom: '24px' }}>
            <img src="https://ui-avatars.com/api/?name=Boss&background=cbfb45&color=000&size=100" style={{ borderRadius: '50%', marginBottom: '12px' }} alt="Profile" />
            <h2 style={{ fontSize: '20px' }}>Chief Executive</h2>
            <p style={{ color: 'var(--text-muted)', fontSize: '14px' }}>admin@eburon.ai</p>
          </div>

          <div className="form-group">
            <label>Persona Background</label>
            <textarea className="form-input" rows={5} placeholder="Tell Beatrice about your business context, communication style..."></textarea>
          </div>

          <div className="form-group" style={{ marginTop: '24px' }}>
            <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>Stored Memories <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>({memories.length})</span></span>
              <select
                className="form-input"
                title="Filter by memory type"
                style={{ width: 'auto', padding: '4px 8px', fontSize: '12px', height: 'auto' }}
                value={memoryFilter}
                onChange={(e) => setMemoryFilter(e.target.value)}
              >
                <option value="all">All Types</option>
                <option value="personal">Personal</option>
                <option value="work">Work</option>
                <option value="project">Project</option>
              </select>
            </label>
            <div className="memory-list" style={{ marginTop: '12px', display: 'flex', flexDirection: 'column', gap: '10px' }}>

              {!isAddingMemory ? (
                <button
                  onClick={() => setIsAddingMemory(true)}
                  style={{ width: '100%', padding: '8px', borderRadius: '8px', border: '1px dashed var(--border-color)', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '13px' }}
                >
                  + Add New Memory
                </button>
              ) : (
                <div style={{ padding: '12px', borderRadius: '8px', backgroundColor: 'rgba(255,255,255,0.05)', display: 'flex', flexDirection: 'column', gap: '8px', border: '1px solid var(--accent-primary)' }}>
                  <textarea
                    className="form-input"
                    value={newMemoryValue}
                    onChange={(e) => setNewMemoryValue(e.target.value)}
                    placeholder="E.g. I prefer concise answers..."
                    rows={2}
                    autoFocus
                  />
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <select className="form-input" title="Memory type" style={{ width: '120px', padding: '4px', fontSize: '12px', height: 'auto' }} value={newMemoryType} onChange={(e) => setNewMemoryType(e.target.value)}>
                      <option value="personal">Personal</option>
                      <option value="work">Work</option>
                      <option value="project">Project</option>
                    </select>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <button className="pill-btn" style={{ fontSize: '11px', padding: '4px 8px' }} onClick={() => { setIsAddingMemory(false); setNewMemoryValue(''); }}>Cancel</button>
                      <button className="pill-btn" style={{ fontSize: '11px', padding: '4px 8px', backgroundColor: 'var(--accent-active)', color: 'var(--bg-main)' }} onClick={handleAddMemory}>Save</button>
                    </div>
                  </div>
                </div>
              )}

              {memories.filter((m) => memoryFilter === 'all' || m.type === memoryFilter).length === 0 ? (
                <div style={{ padding: '16px', borderRadius: '8px', backgroundColor: 'rgba(255,255,255,0.05)', color: 'var(--text-muted)', fontSize: '13px', textAlign: 'center' }}>
                  No memories found.
                </div>
              ) : (
                memories.filter((m) => memoryFilter === 'all' || m.type === memoryFilter).map((m) => (
                  <div key={m.id} className="memory-item" style={{ padding: '12px', borderRadius: '8px', backgroundColor: 'rgba(255,255,255,0.05)', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    {editingMemoryIndex === m.id ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        <textarea
                          className="form-input"
                          value={editingMemoryValue}
                          onChange={(e) => setEditingMemoryValue(e.target.value)}
                          rows={2}
                          autoFocus
                        />
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <select className="form-input" title="Memory type" style={{ width: '120px', padding: '4px', fontSize: '12px', height: 'auto' }} value={editingMemoryType} onChange={(e) => setEditingMemoryType(e.target.value)}>
                            <option value="personal">Personal</option>
                            <option value="work">Work</option>
                            <option value="project">Project</option>
                          </select>
                          <div style={{ display: 'flex', gap: '8px' }}>
                            <button
                              className="pill-btn"
                              style={{ fontSize: '11px', padding: '4px 8px' }}
                              onClick={() => setEditingMemoryIndex(null)}
                            >Cancel</button>
                            <button
                              className="pill-btn"
                              style={{ fontSize: '11px', padding: '4px 8px', backgroundColor: 'var(--accent-active)', color: 'var(--bg-main)' }}
                              onClick={() => handleUpdateMemory(m.id, editingMemoryValue, editingMemoryType)}
                            >Save</button>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                          <span style={{ fontSize: '13px', lineHeight: '1.4', flex: 1 }}>{m.content}</span>
                          <div style={{ display: 'flex', gap: '4px', marginLeft: '12px' }}>
                            <button title="Edit memory"
                              className="icon-btn"
                              style={{ color: 'var(--text-muted)', background: 'transparent', border: 'none', cursor: 'pointer' }}
                              onClick={() => {
                                setEditingMemoryIndex(m.id);
                                setEditingMemoryValue(m.content);
                                setEditingMemoryType(m.type || 'personal');
                              }}
                            >
                              <i className="ph ph-note-pencil"></i>
                            </button>
                            <button title="Delete memory"
                              className="icon-btn"
                              style={{ color: '#ff4d4d', background: 'transparent', border: 'none', cursor: 'pointer' }}
                              onClick={() => handleDeleteMemory(m.id)}
                            >
                              <i className="ph ph-trash"></i>
                            </button>
                          </div>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span style={{
                            fontSize: '10px',
                            color: m.type === 'project' ? '#a855f7' : m.type === 'work' ? '#3b82f6' : 'var(--accent-active)',
                            backgroundColor: m.type === 'project' ? 'rgba(168,85,247,0.15)' : m.type === 'work' ? 'rgba(59,130,246,0.15)' : 'rgba(203,251,69,0.1)',
                            padding: '2px 8px',
                            borderRadius: '12px',
                            textTransform: 'uppercase',
                            letterSpacing: '0.5px',
                            fontWeight: 600
                          }}>{m.type || 'Personal'}</span>
                          <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{new Date(m.created_at || m.updatedAt).toLocaleDateString()}</span>
                        </div>
                      </>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>

          <button className="save-now-btn" onClick={async (e) => {
            const btn = e.currentTarget;
            try {
              await api.updateSettings({
                persona_name: personaName,
                user_call_name: userCallName,
                system_prompt: systemPrompt,
                voice: voice,
                language: language
              });
              btn.textContent = 'Saved!';
              setTimeout(() => { btn.textContent = 'Save Now'; setActiveOverlay(null); }, 1500);
            } catch (err) {
              console.error("Error saving settings:", err);
              btn.textContent = "Error!";
              setTimeout(() => { btn.textContent = "Save Now"; }, 1500);
            }
          }}>Save Now</button>

          <div className="danger-action" onClick={() => {
            signOut(auth);
            useAuth.getState().setGoogleAccessToken(null);
          }}>
            Log Out
          </div>
        </div>
      </div>

      {/* Settings Overlay */}
      <div id="overlay-settings" className={`full-page-overlay ${activeOverlay === 'settings' ? 'active' : ''}`}>
        <div className="overlay-header">
          <div className="overlay-title">App Settings</div>
          <button className="close-overlay-btn" title="Close settings" onClick={() => setActiveOverlay(null)}><i className="ph-bold ph-x"></i></button>
        </div>
        <div className="overlay-content">
          <div className="form-group">
            <label>Persona Name</label>
            <input type="text" className="form-input" title="Persona name" placeholder="Beatrice" value={personaName} onChange={(e) => setPersonaName(e.target.value)} />
          </div>
          <div className="form-group">
            <label>How to call you</label>
            <input type="text" className="form-input" title="User call name" placeholder="Boss" value={userCallName} onChange={(e) => setUserCallName(e.target.value)} />
          </div>

          <div className="form-group">
            <label>Behavior Persona (How does it react? How does it respond?)</label>
            <textarea
              className="form-input"
              rows={4}
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder="e.g. Friendly, patient, and solutions-oriented..."
            />
          </div>

          <div className="form-group">
            <label>Presets</label>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '8px' }}>
              <button
                className="pill-btn"
                onClick={() => setTemplate('personal-assistant')}
                style={{ padding: '6px 12px', borderRadius: '16px', border: '1px solid var(--border-color)', fontSize: '12px', background: 'transparent', cursor: 'pointer' }}
              >
                Personal Assistant
              </button>
              <button
                className="pill-btn"
                onClick={() => setTemplate('customer-support')}
                style={{ padding: '6px 12px', borderRadius: '16px', border: '1px solid var(--border-color)', fontSize: '12px', background: 'transparent', cursor: 'pointer' }}
              >
                Customer Support
              </button>
              <button
                className="pill-btn"
                onClick={() => setTemplate('navigation-system')}
                style={{ padding: '6px 12px', borderRadius: '16px', border: '1px solid var(--border-color)', fontSize: '12px', background: 'transparent', cursor: 'pointer' }}
              >
                Navigation System
              </button>
            </div>
          </div>

          <div className="form-group">
            <label>Voice Persona</label>
            <select className="form-input" title="Voice persona" onChange={(e) => setVoice(e.target.value)} value={voice}>
              <option value="Aoede">Aoede</option>
              <option value="Charon">Charon</option>
              <option value="Fenrir">Fenrir</option>
              <option value="Kore">Kore</option>
              <option value="Puck">Puck</option>
            </select>
          </div>
          <div className="form-group">
            <label>Language</label>
            <select className="form-input" title="Language" onChange={(e) => setLanguage(e.target.value)} value={language}>
              {LANGUAGES.map((lang) => (
                <option key={lang} value={lang}>{lang}</option>
              ))}
            </select>
          </div>
          <button className="save-now-btn" onClick={async (e) => {
            const btn = e.currentTarget;
            try {
              await api.updateSettings({
                persona_name: personaName,
                user_call_name: userCallName,
                system_prompt: systemPrompt,
                voice: voice,
                language: language
              });
              setActiveOverlay(null);
            } catch (err) {
              console.error("Error saving settings:", err);
            }
          }}>Save Settings</button>
        </div>
      </div>

      {/* WhatsApp Settings */}
      <div id="overlay-whatsapp" className={`full-page-overlay ${activeOverlay === 'whatsapp' ? 'active' : ''}`}>
        <div className="overlay-header">
          <div className="overlay-title">WhatsApp</div>
          <button className="close-overlay-btn" title="Close WhatsApp" onClick={() => setActiveOverlay(null)}><i className="ph-bold ph-x"></i></button>
        </div>
        <div className="overlay-content">
          <WhatsAppConnectPanel />
        </div>
      </div>

      {/* Knowledge Base Overlay */}
      <div id="overlay-kb" className={`full-page-overlay ${activeOverlay === 'kb' ? 'active' : ''}`}>
        <div className="overlay-header">
          <div className="overlay-title"><i className="ph-fill ph-books" style={{ color: 'var(--accent-primary)', marginRight: '8px' }}></i>Knowledge Base</div>
          <button className="close-overlay-btn" title="Close KB" onClick={() => setActiveOverlay(null)}><i className="ph-bold ph-x"></i></button>
        </div>
        <div className="overlay-content">
          <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginBottom: '16px' }}>Upload documents to give Beatrice context. Supported: text, code, PDF (text layer), JSON, CSV, markdown, and more.</p>
          <label style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px',
            padding: '18px', border: '2px dashed var(--border-color)', borderRadius: '16px',
            cursor: 'pointer', color: 'var(--accent-primary)', fontWeight: 600, fontSize: '15px',
            marginBottom: '24px', transition: 'border-color 0.2s'
          }}>
            <i className="ph-duotone ph-upload-simple" style={{ fontSize: '22px' }}></i>
            Upload Files
            <input type="file" multiple style={{ display: 'none' }} onChange={async (e) => {
              const files = Array.from(e.target.files || []);
              const newFiles: { name: string; content: string; size: number }[] = [];
              for (const file of files) {
                try {
                  const text = await file.text();
                  newFiles.push({ name: file.name, content: text.slice(0, 50000), size: file.size });
                } catch {
                  newFiles.push({ name: file.name, content: `[Could not read file: ${file.name}]`, size: file.size });
                }
              }
              setKbFiles(prev => [...prev, ...newFiles]);
              e.target.value = '';
            }} />
          </label>
          {kbFiles.length === 0 && (
            <p style={{ color: 'var(--text-muted)', textAlign: 'center', marginTop: '40px' }}>No documents uploaded yet.</p>
          )}
          {kbFiles.map((f, i) => (
            <div key={i} style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              background: 'var(--bg-chip)', borderRadius: '12px', padding: '12px 16px', marginBottom: '8px'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', overflow: 'hidden' }}>
                <i className="ph-duotone ph-file-text" style={{ fontSize: '20px', color: 'var(--accent-primary)', flexShrink: 0 }}></i>
                <div style={{ overflow: 'hidden' }}>
                  <div style={{ fontSize: '14px', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.name}</div>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{(f.size / 1024).toFixed(1)} KB &bull; {f.content.length.toLocaleString()} chars</div>
                </div>
              </div>
              <button title="Remove file" onClick={() => setKbFiles(prev => prev.filter((_, idx) => idx !== i))} style={{
                background: 'none', border: 'none', color: 'var(--accent-danger)', cursor: 'pointer', fontSize: '18px', padding: '4px'
              }}><i className="ph-bold ph-trash"></i></button>
            </div>
          ))}
          {kbFiles.length > 0 && (
            <button onClick={() => setKbFiles([])} style={{
              marginTop: '16px', width: '100%', padding: '14px', borderRadius: '50px',
              background: 'var(--accent-danger)', color: '#fff', border: 'none',
              fontWeight: 600, fontSize: '14px', cursor: 'pointer'
            }}>Clear All Documents</button>
          )}
        </div>
      </div>

      {/* History Overlay */}
      <div id="overlay-history" className={`full-page-overlay ${activeOverlay === 'history' ? 'active' : ''}`}>
        <div className="overlay-header">
          <div className="overlay-title">Activity History</div>
          <button className="close-overlay-btn" title="Close history" onClick={() => setActiveOverlay(null)}><i className="ph-bold ph-x"></i></button>
        </div>

        <div className="history-filters" style={{ padding: '16px 24px', background: 'rgba(255,255,255,0.02)', borderBottom: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div className="search-box" style={{ position: 'relative' }}>
            <i className="ph ph-magnifying-glass" style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }}></i>
            <input
              type="text"
              className="form-input"
              title="Search conversation"
              placeholder="Search conversation..."
              style={{ paddingLeft: '40px' }}
              value={historySearch}
              onChange={(e) => setHistorySearch(e.target.value)}
            />
          </div>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <select className="form-input" title="Filter by role" style={{ width: 'auto', flex: 1, height: '40px' }} value={historyRoleFilter} onChange={(e) => setHistoryRoleFilter(e.target.value as any)}>
              <option value="all">Every Role</option>
              <option value="user">User Only</option>
              <option value="agent">Agent Only</option>
              <option value="system">Tools Only</option>
            </select>
            <select className="form-input" title="Filter by date" style={{ width: 'auto', flex: 1, height: '40px' }} value={historyDateRange} onChange={(e) => setHistoryDateRange(e.target.value as any)}>
              <option value="all">All Sessions</option>
              <option value="today">Today</option>
              <option value="week">This Week</option>
            </select>
          </div>
          {historyRoleFilter === 'system' && (
            <div className="tool-chips" style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '4px' }}>
              {['search', 'save_memory', 'meeting', 'artifact', 'command'].map(tool => (
                <button
                  key={tool}
                  className="pill-btn"
                  style={{
                    fontSize: '10px',
                    padding: '4px 8px',
                    backgroundColor: historyToolFilter === tool ? 'var(--accent-active)' : 'transparent',
                    color: historyToolFilter === tool ? 'var(--bg-main)' : 'var(--text-muted)',
                    border: '1px solid var(--border-color)'
                  }}
                  onClick={() => setHistoryToolFilter(prev => prev === tool ? 'all' : (tool as any))}
                >
                  {tool.replace('save_', '')}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="overlay-content" style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {historyError ? (
            <div style={{ padding: '20px', borderRadius: '12px', background: 'rgba(255,100,100,0.05)', border: '1px solid rgba(255,100,100,0.2)', color: '#ff8888', fontSize: '14px', textAlign: 'center' }}>
              <i className="ph-bold ph-warning-circle" style={{ display: 'block', fontSize: '32px', marginBottom: '12px' }}></i>
              {historyError}
            </div>
          ) : (!allHistory || allHistory.length === 0) ? (
            <p style={{ color: 'var(--text-muted)', textAlign: 'center', marginTop: '40px' }}>No history yet.</p>
          ) : (() => {
            // Filter
            const filtered = allHistory.filter(t => {
              const matchesSearch = (t.text || t.content || '').toLowerCase().includes(historySearch.toLowerCase());
              let matchesRole = true;
              if (historyRoleFilter !== 'all') matchesRole = t.role === historyRoleFilter;
              let matchesTool = true;
              if (historyRoleFilter === 'system' && historyToolFilter !== 'all') matchesTool = t.toolName?.includes(historyToolFilter) || false;
              let matchesDate = true;
              if (historyDateRange !== 'all') {
                const date = t.message_timestamp ? new Date(t.message_timestamp) : (t.created_at ? new Date(t.created_at) : new Date());
                const now = new Date();
                if (historyDateRange === 'today') matchesDate = date.toDateString() === now.toDateString();
                else if (historyDateRange === 'week') {
                  const weekAgo = new Date(); weekAgo.setDate(now.getDate() - 7);
                  matchesDate = date >= weekAgo;
                }
              }
              return matchesSearch && matchesRole && matchesTool && matchesDate;
            });

            // Group by session (source field)
            const sessions = new Map<string, any[]>();
            for (const t of filtered) {
              const sid = t.session_id || `session-${new Date(t.message_timestamp || t.created_at).toDateString()}`;
              if (!sessions.has(sid)) sessions.set(sid, []);
              sessions.get(sid)!.push(t);
            }

            // Sort sessions by newest first
            const sortedSessions = Array.from(sessions.entries()).sort((a, b) => {
              const aTime = new Date(a[1][0].message_timestamp || a[1][0].created_at).getTime();
              const bTime = new Date(b[1][0].message_timestamp || b[1][0].created_at).getTime();
              return bTime - aTime;
            });

            return sortedSessions.map(([sessionId, msgs]) => {
              const sessionLabel = sessionId.startsWith('session-') ? sessionId : `Session ${sessionId.slice(0, 8)}`;
              const sessionDate = msgs[0]?.message_timestamp || msgs[0]?.created_at;
              const dateStr = new Date(sessionDate).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
              const userCount = msgs.filter(m => m.role === 'user').length;
              return (
                <details key={sessionId} className="history-session" style={{ borderRadius: '12px', border: '1px solid var(--border-color)', overflow: 'hidden' }}>
                  <summary style={{ padding: '12px 16px', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(255,255,255,0.03)', fontSize: '13px', fontWeight: 600 }}>
                    <span><i className="ph-fill ph-chats" style={{ marginRight: '8px', color: 'var(--accent-active)' }}></i>{sessionLabel}</span>
                    <span style={{ color: 'var(--text-muted)', fontSize: '11px', fontWeight: 400 }}>{dateStr} &middot; {msgs.length} messages ({userCount} from you)</span>
                  </summary>
                  <div style={{ padding: '8px 16px 16px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    {msgs.map((turn, idx) => (
                      <div key={idx} className={`history-item ${turn.role}`} style={{
                        padding: '10px 12px', borderRadius: '10px',
                        backgroundColor: turn.role === 'user' ? 'rgba(203,251,69,0.05)' : turn.role === 'system' ? 'rgba(255,255,255,0.01)' : 'rgba(255,255,255,0.03)',
                        border: `1px solid ${turn.role === 'user' ? 'rgba(203,251,69,0.1)' : 'rgba(255,255,255,0.05)'}`,
                      }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                          <span style={{ fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1px', color: turn.role === 'user' ? 'var(--accent-active)' : 'var(--text-muted)' }}>
                            {turn.role === 'user' ? userCallName : turn.role === 'system' ? 'System' : personaName}
                          </span>
                          {(turn.message_timestamp || turn.created_at) && <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{new Date(turn.message_timestamp || turn.created_at).toLocaleTimeString()}</span>}
                        </div>
                        <div style={{ fontSize: '13px', lineHeight: '1.5', color: 'var(--text-main)' }}>
                          <ReactMarkdown>{turn.text || turn.content || ''}</ReactMarkdown>
                        </div>
                      </div>
                    ))}
                  </div>
                </details>
              );
            });
          })()}
        </div>
      </div>

      {/* Automation Overlay */}
      <div id="overlay-automation" className={`full-page-overlay ${activeOverlay === 'automation' ? 'active' : ''}`}>
        <div className="overlay-header">
          <div className="overlay-title"><i className="ph-fill ph-robot" style={{ color: 'var(--accent-active)', marginRight: '8px' }}></i>Automations</div>
          <button className="close-overlay-btn" title="Close automations" onClick={() => setActiveOverlay(null)}><i className="ph-bold ph-x"></i></button>
        </div>
        <div className="overlay-content" style={{ overflowY: 'auto' }}>
          <AutomationPanel />
        </div>
      </div>

      {/* Tools Overlay */}
      <div id="overlay-tools" className={`full-page-overlay ${activeOverlay === 'tools' ? 'active' : ''}`}>
        <div className="overlay-header">
          <div className="overlay-title">Integrations</div>
          <button className="close-overlay-btn" title="Close integrations" onClick={() => setActiveOverlay(null)}><i className="ph-bold ph-x"></i></button>
        </div>
        <div className="overlay-content"><p style={{ color: 'var(--text-muted)', textAlign: 'center', marginTop: '40px' }}>All tools active.</p></div>
      </div>
      {showResultPage && (
        <div className="result-overlay" style={{
          position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh',
          backgroundColor: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(12px)',
          zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'var(--text-main)', fontFamily: 'Inter, system-ui, sans-serif'
        }}>
          <div className="result-content" style={{
            width: '90%', maxWidth: '800px', maxHeight: '80vh',
            backgroundColor: 'var(--bg-card)', borderRadius: '24px',
            padding: '40px', overflowY: 'auto', boxShadow: '0 20px 50px rgba(0,0,0,0.5)',
            border: '1px solid var(--border-color)', position: 'relative'
          }}>
            <button onClick={() => setShowResultPage(false)} style={{
              position: 'absolute', top: '20px', right: '20px',
              background: 'none', border: 'none', color: 'var(--text-muted)',
              cursor: 'pointer', fontSize: '24px', padding: '0'
            }}>×</button>
            <h2 style={{ fontSize: '28px', marginBottom: '24px', fontWeight: 800, color: 'var(--accent-primary)' }}>Task Result</h2>
            <div className="result-body" style={{ lineHeight: '1.6', fontSize: '16px', whiteSpace: 'pre-wrap' }}>
              {resultData || 'No data available.'}
            </div>
          </div>
        </div>
      )}

      {/* Auth Screen */}
      <div id="auth-screen" className={`full-page-overlay ${isAuthOpen ? 'active' : ''}`}>
        <div className="auth-glow"></div>
        <div className="auth-card" id="auth-card-inner">
          <div className="auth-logo-box" style={{ background: 'transparent' }}>
            <img src="https://eburon.ai/icon-eburon.svg" alt="Eburon Logo" style={{ width: '60px', height: '60px' }} />
          </div>

          <h2>{isSignupMode ? 'Register' : 'Login'}</h2>
          <p className="subtitle">{isSignupMode ? 'Create your new account' : 'Welcome back to Eburon'}</p>

          <form className="auth-form" onSubmit={handleEmailAuth}>
            {authError && <div style={{ color: 'red', marginBottom: '10px', fontSize: '14px' }}>{authError}</div>}
            {isSignupMode && (
              <div className="auth-input-wrapper">
                <i className="ph ph-user auth-icon-left"></i>
                <input type="text" title="Full name" placeholder="Full name" value={name} onChange={e => setName(e.target.value)} />
              </div>
            )}
            <div className="auth-input-wrapper">
              <i className="ph ph-envelope auth-icon-left"></i>
              <input type="email" title="Email" placeholder="Email" required value={email} onChange={e => setEmail(e.target.value)} />
            </div>
            <div className="auth-input-wrapper">
              <i className="ph ph-lock auth-icon-left"></i>
              <input type="password" title="Password" placeholder="Password" required value={password} onChange={e => setPassword(e.target.value)} />
            </div>
            {isSignupMode && (
              <div className="auth-input-wrapper">
                <i className="ph ph-lock auth-icon-left"></i>
                <input type="password" title="Confirm password" placeholder="Confirm password" />
              </div>
            )}
            <button type="submit" className="auth-submit-btn">{isSignupMode ? 'Sign up' : 'Sign in'}</button>
          </form>

          {!isSignupMode && (
            <div className="auth-links" style={{ display: "flex", gap: "16px", marginTop: "12px", fontSize: "13px" }}>
              <span style={{ color: "var(--accent-primary)", cursor: "pointer", fontWeight: 600 }} onClick={() => setIsSignupMode(true)}>Create account</span>
              <span style={{ color: "var(--text-muted)", cursor: "pointer" }} onClick={async () => {
                if (!email) { setAuthError("Enter your email first."); return; }
                try {
                  const { sendPasswordResetEmail } = await import('firebase/auth');
                  await sendPasswordResetEmail(auth, email);
                  setAuthError("Password reset email sent!");
                } catch (err: any) { setAuthError(err.message); }
              }}>Reset password</span>
            </div>
          )}

          {isSignupMode && (
            <div className="auth-toggle" style={{ marginTop: "12px", fontSize: "13px", color: "var(--text-muted)" }}>
              Already have an account? <span style={{ color: "var(--accent-primary)", fontWeight: 600, cursor: "pointer" }} onClick={() => setIsSignupMode(false)}>Sign in</span>
            </div>
          )}

          <div className="auth-divider"><span>or</span></div>

          <button className="btn-google" onClick={handleGoogleLogin}>
            <div className="g-icon-circle">G</div>
            Continue with Google
          </button>
        </div>
      </div>
    </div>
  );
}


// Hook to enumerate and set audio output device
export function useAudioOutputDevice() {
  const [deviceId, setDeviceId] = useState<string>('');

  const enumerateDevices = useCallback(async () => {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter(d => d.kind === 'audiooutput');
  }, []);

  const setOutputDevice = useCallback(async (id: string) => {
    try {
      const ctx = await import('@/lib/utils').then(m => m.audioContext({ id: 'audio-out' }));
      // Set the default sink for the AudioContext's destination
      if ('setSinkId' in ctx.destination) {
        await (ctx.destination as any).setSinkId(id);
        setDeviceId(id);
      }
    } catch (e) {
      console.error('Failed to set audio output device:', e);
    }
  }, []);

  return { deviceId, setOutputDevice, enumerateDevices };
}
