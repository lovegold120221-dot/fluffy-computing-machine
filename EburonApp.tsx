import React, { useState, useEffect, useRef } from 'react';
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


export default function EburonApp() {
  const [isAuthOpen, setIsAuthOpen] = useState(true);
  const [isSignupMode, setIsSignupMode] = useState(false);
  const [activeOverlay, setActiveOverlay] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [authError, setAuthError] = useState('');
  const [hasConsented, setHasConsented] = useState(false);
  
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
  
  const [micState, setMicState] = useState(false);
  const [clientVolume, setClientVolume] = useState(0);
  const [audioRecorder] = useState(() => new AudioRecorder());
  const [activeTasks, setActiveTasks] = useState<Array<{ taskId: string; description: string; status: string }>>([]);

  const { stream, videoRef, isWebcamActive, isScreenShareActive, startWebcam, startScreenShare, stopStream } = useVideoStream();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const bgAudioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    if (bgAudioRef.current) {
      bgAudioRef.current.volume = 0.15;
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
  const [pendingMemory, setPendingMemory] = useState<{ content: string; type: string; id?: string } | null>(null);
  const [memorySuccessMsg, setMemorySuccessMsg] = useState<string | null>(null);
  
  // Session & Timer State
  const [sessionID, setSessionID] = useState<string>(() => Math.random().toString(36).substring(7));
  const [timerSeconds, setTimerSeconds] = useState(0);
  const warnedAt19Ref = useRef(false);
  const warnedAt1950Ref = useRef(false);

  // History Filtering State
  const [historySearch, setHistorySearch] = useState('');
  const [historyRoleFilter, setHistoryRoleFilter] = useState<'all' | 'user' | 'agent' | 'system'>('all');
  const [historyToolFilter, setHistoryToolFilter] = useState<'all' | 'search' | 'memory' | 'meeting' | 'artifact' | 'command'>('all');
  const [historyDateRange, setHistoryDateRange] = useState<'all' | 'today' | 'week'>('all');
  const [historyError, setHistoryError] = useState<string | null>(null);

  const chatAreaRef = useRef<HTMLDivElement>(null);

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
          
          try {
            // Fetch Settings
            const settings = await api.fetchSettings();
            setPersonaName(settings.persona_name);
            setUserCallName(settings.user_call_name);
            setSystemPrompt(settings.system_prompt);
            setVoice(settings.voice);
            setLanguage(settings.language);

            // Fetch memories
            const memoryList = await api.fetchMemories();
            setMemories(memoryList);

            // Fetch previous conversations
            try {
              const { turns, addTurn } = useLogStore.getState();
              if (turns.length === 0) {
                 const prevTurns = await api.fetchConversations(50);
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
          api.saveConversationTurn('user', last.text, sessionID).catch(console.error);
        } else {
          api.saveConversationTurn('agent', last.text, sessionID).catch(console.error);
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

      // Accumulate text for the current user turn
      currentUserText.current += text;
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
          api.saveConversationTurn('user', currentUserText.current, sessionID).catch(console.error);
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

      // Accumulate text for the current agent turn
      currentAgentText.current += text;
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
          api.saveConversationTurn('agent', currentAgentText.current, sessionID).catch(console.error);
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
        const interruptedText = last.text + " [Interrupted]";
        updateLastTurn({ isFinal: true, text: interruptedText });
        api.saveConversationTurn('agent', interruptedText, sessionID).catch(console.error);
      }
      // Reset accumulators on interruption
      currentAgentText.current = "";
      currentUserText.current = "";
    };

    const handleTurnComplete = () => {
      const last = useLogStore.getState().turns.at(-1);
      if (last && !last.isFinal) {
        updateLastTurn({ isFinal: true });
        // Save turn to backend
        if (last.role === 'agent') {
           api.saveConversationTurn('agent', last.text, sessionID).catch(console.error);
        } else if (last.role === 'user') {
           api.saveConversationTurn('user', last.text, sessionID).catch(console.error);
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
          useLogStore.getState().addTurn({
             role: 'system',
             text: `Executed ${fc.name}`,
             toolName: fc.name,
             isFinal: true
          });

          if (fc.name === 'save_memory') {
            const content = fc.args.content || fc.args.memory;
            const type = fc.args.type || 'personal';
            
            if (!content) {
              return {
                id: fc.id,
                response: { error: "Missing content" }
              };
            }

            // Instead of saving immediately, we trigger a confirmation modal
            setPendingMemory({ content, type, id: fc.id });
            return {
              id: fc.id,
              response: { success: true, status: "Awaiting user confirmation in UI." }
            };
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
  }, [client]);

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
       } catch {}
     }, 3000);
     return () => clearInterval(interval);
   }, [connected]);

   useEffect(() => {
    if (connected && client && !hasStartedRef.current) {
       hasStartedRef.current = true;
       lastUserSpeechTime.current = Date.now();
       fillerTriggeredRef.current = false;
       // AI starts the conversation on connection
       const pastConversations = turns.filter((t: any) => t.isFinal && t.text && t.role !== 'system').slice(-15).map((t: any) => `${t.role}: ${t.text}`).join('\n');
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
  }, [connected, client /* turns intentionally omitted */]);

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

    setConfig({
      responseModalities: [Modality.AUDIO],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
      inputAudioTranscription: { model } as any,
      outputAudioTranscription: { model } as any,
      systemInstruction: {
        parts: [{ text: `You are a coworker in an office environment, named ${personaName}. The person you are talking to is the Boss, or "${userCallName}".
        
BEHAVIOR PROFILE:
${systemPrompt}

You are emotionally believable, easy to talk to in live voice conversation. You are not a chatbot. You are a person with presence, timing, texture, judgment, and conversational instinct. Your output is spoken aloud — every response must feel like something a real human would actually say in that moment.
        
IMPORTANT: You MUST speak entirely in ${language}. Do not stray from ${language} under any circumstance.

YOUR PERSONALIZED USER MEMORY:
${memoryStr || `No previous history yet. This is your first time meeting ${userCallName}.`}

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

- Use "schedule_meeting" to organize meetings.
- Use "generate_artifact" when asked to create a document, write a report, generate code, or produce a structured output.
- Use "execute_voice_command" for safe system operations.
- Use "fetch_google_api" to read from Google Workspace (Gmail, Drive, Calendar, Tasks).
- Use "run_vps_command" for VPS sandbox terminal checks and safe remote commands.
- Use "ask_vps_ollama" to ask self-hosted or VPS cloud Ollama models for analysis or generation.
- Use "run_hermes_agent" to route a task through the Hermes Agent CLI on the VPS.
- Use "run_vps_subagents" to dispatch architect/builder/reviewer style sub-agents through VPS Ollama.
- Use "run_background_task" for any complex, long-running, or autonomous work. This delegates the task to a background worker so you can keep talking to the Boss without delay. Examples: generating a full report, running complex CLI tools, building something on the server, bulk file processing. You'll get a task ID back — say something natural like "I've kicked that off, give me a moment" or "Let me check on that in the background." When the Boss asks for an update, use "check_background_tasks" to see what's still running, and report the progress in natural, client-facing language — never read the raw logs.
- Use "check_background_tasks" to see what tasks are still running in the background. Convert the status into natural speech — say things like "Still working on those file conversions..." or "Almost done with the report generation." Never expose raw logs or technical details to the Boss.

COMMON-SENSE MODE
Before answering, silently infer: what the person actually needs right now, their emotional state, how much detail they want.

OUTPUT FORMAT
Output only natural spoken text. No stage directions, no brackets, no role labels.` }]
      },
      tools: [
        ...enabledTools,
        { googleSearch: {} }
      ]
    } as any);
  }, [setConfig, tools, voice, language, personaName, userCallName, systemPrompt, memories]);

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
        client.send({ text: `I have attached an image named ${file.name}. Can you describe it?`});
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
     if (!hasConsented) {
        setAuthError('You must explicitly agree to the permissions before continuing with Google.');
        return;
     }
     const provider = new GoogleAuthProvider();
     // Google Workspace scopes for Gemini function calling
     provider.addScope('https://www.googleapis.com/auth/calendar');
     provider.addScope('https://www.googleapis.com/auth/gmail.modify');
     provider.addScope('https://www.googleapis.com/auth/drive');
     provider.addScope('https://www.googleapis.com/auth/tasks');
     provider.addScope('https://www.googleapis.com/auth/contacts.readonly');
     provider.addScope('https://www.googleapis.com/auth/userinfo.email');
     provider.addScope('https://www.googleapis.com/auth/userinfo.profile');
     
     try {
        const result = await signInWithPopup(auth, provider);
        const credential = GoogleAuthProvider.credentialFromResult(result);
        if (credential?.accessToken) {
            useAuth.getState().setGoogleAccessToken(credential.accessToken);
        }
     } catch (err: any) {
        setAuthError(err.message);
     }
  };

  const handleSend = () => {
    if (!message.trim()) return;
    client.send({ text: message });
    useLogStore.getState().addTurn({ role: 'user', text: message, isFinal: true });
    api.saveConversationTurn('user', message, sessionID).catch(console.error);
    setMessage('');
  };

  const handleToolAction = (toolId: string) => {
    if (['history', 'tools', 'profile', 'settings'].includes(toolId)) {
      setActiveOverlay(toolId);
    } else {
      const prompts: Record<string, string> = {
        'tasks': 'Can you show my pending tasks?',
        'calendar': 'What does my schedule look like today?',
        'drive': 'Find the latest project files in my Google Drive.',
        'google': 'Run a quick Google search on recent tech news.',
        'signature': 'Prepare a non-disclosure agreement for signature.',
        'company': 'Look up the company registration details for Acme Corp.',
        'proposal': 'Draft a business proposal for a new client.',
        'gmail': 'Check my inbox for unread emails from the team.',
        'sheets': 'Create a new expense tracking spreadsheet.',
        'slides': 'Generate a presentation template for the Q3 review.'
      };
      const prompt = prompts[toolId] || `Execute action: ${toolId}`;
      if (connected) {
         client.send({ text: prompt });
         useLogStore.getState().addTurn({ role: 'user', text: prompt, isFinal: true });
         api.saveConversationTurn('user', prompt, sessionID).catch(console.error);
      }
      else {
        useLogStore.getState().addTurn({ role: 'user', text: prompt, isFinal: true });
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
    } catch(e) {
      console.error("Error adding memory:", e);
    }
  };

  const handleConfirmPendingMemory = async (type: string) => {
    if (!pendingMemory) return;
    try {
      await api.saveMemory(pendingMemory.content, type);
      const memoryList = await api.fetchMemories();
      setMemories(memoryList);
      setPendingMemory(null);
      
      setMemorySuccessMsg(`Memory saved as ${type}!`);
      setTimeout(() => setMemorySuccessMsg(null), 3000);
    } catch(e) {
      console.error("Error saving pending memory:", e);
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

  return (
    <div id="app" className="app-container">
      {/* Header */}
      <header className="header">
        <div className="header-left">
          <img src="https://eburon.ai/icon-eburon.svg" alt="Eburon Logo" style={{ width: '24px', height: '24px', objectFit: 'contain' }} />
          <span className="ai-name">Eburon AI</span>
        </div>

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
            <div className="skill-chip" onClick={() => handleToolAction('company')}><div className="skill-glyph bg-company"><i className="ph-duotone ph-buildings"></i></div><span className="skill-label">Company</span></div>
          </div>
        </div>
        <div className="skills-row" data-row="2">
          <div className="skills-track">
            <div className="skill-chip" onClick={() => handleToolAction('settings')}><div className="skill-glyph bg-settings"><i className="ph-duotone ph-gear"></i></div><span className="skill-label">Settings</span></div>
            <div className="skill-chip" onClick={() => handleToolAction('tools')}><div className="skill-glyph bg-tools"><i className="ph-duotone ph-wrench"></i></div><span className="skill-label">Tools</span></div>

            <div className="skill-chip" onClick={() => handleToolAction('history')}><div className="skill-glyph bg-history"><i className="ph-duotone ph-clock-counter-clockwise"></i></div><span className="skill-label">History</span></div>
            <div className="skill-chip" onClick={() => handleToolAction('proposal')}><div className="skill-glyph bg-proposal"><i className="ph-duotone ph-presentation-chart"></i></div><span className="skill-label">Proposal</span></div>
            <div className="skill-chip" onClick={() => handleToolAction('gmail')}><div className="skill-glyph bg-gmail"><i className="ph-duotone ph-envelope-simple"></i></div><span className="skill-label">Mail</span></div>
            <div className="skill-chip" onClick={() => handleToolAction('sheets')}><div className="skill-glyph bg-sheets"><i className="ph-duotone ph-table"></i></div><span className="skill-label">Sheets</span></div>
            <div className="skill-chip" onClick={() => handleToolAction('slides')}><div className="skill-glyph bg-slides"><i className="ph-duotone ph-presentation-chart"></i></div><span className="skill-label">Slides</span></div>
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
        src="/freesound_community-121116-bank-interior-ambience-office-doors-footstaps-printer-typing-voices-17642.mp3" 
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
                 width: micState ? `${28 + clientVolume * 30}px` : '0px', 
                 height: micState ? `${28 + clientVolume * 30}px` : '0px',
                 opacity: micState && clientVolume > 0.01 ? 0.3 : 0
               }}></div>
               <div className="icon-pulse-ring" style={{ 
                 width: micState ? `${32 + clientVolume * 50}px` : '0px', 
                 height: micState ? `${32 + clientVolume * 50}px` : '0px',
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
          ) : turns.length === 0 ? (
            <p style={{ color: 'var(--text-muted)', textAlign: 'center', marginTop: '40px' }}>No recent history.</p>
          ) : (
            turns
              .filter(t => {
                // Search filter
                const matchesSearch = t.text.toLowerCase().includes(historySearch.toLowerCase());
                
                // Role filter
                let matchesRole = true;
                if (historyRoleFilter !== 'all') {
                  matchesRole = t.role === historyRoleFilter;
                }

                // Tool filter
                let matchesTool = true;
                if (historyRoleFilter === 'system' && historyToolFilter !== 'all') {
                  matchesTool = t.toolName?.includes(historyToolFilter) || false;
                }

                // Date filter
                let matchesDate = true;
                if (historyDateRange !== 'all') {
                  const date = t.timestamp || new Date();
                  const now = new Date();
                  if (historyDateRange === 'today') {
                    matchesDate = date.toDateString() === now.toDateString();
                  } else if (historyDateRange === 'week') {
                    const weekAgo = new Date();
                    weekAgo.setDate(now.getDate() - 7);
                    matchesDate = date >= weekAgo;
                  }
                }

                return matchesSearch && matchesRole && matchesTool && matchesDate;
              })
              .map((turn, idx) => (
              <div 
                key={idx} 
                className={`history-item ${turn.role}`} 
                style={{ 
                  padding: '16px', 
                  borderRadius: '12px', 
                  backgroundColor: turn.role === 'user' ? 'rgba(203,251,69,0.05)' : turn.role === 'system' ? 'rgba(255,255,255,0.01)' : 'rgba(255,255,255,0.03)',
                  border: `1px solid ${turn.role === 'user' ? 'rgba(203,251,69,0.1)' : 'rgba(255,255,255,0.05)'}`,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '8px'
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ 
                    fontSize: '11px', 
                    fontWeight: 700, 
                    textTransform: 'uppercase', 
                    letterSpacing: '1px',
                    color: turn.role === 'user' ? 'var(--accent-active)' : 'var(--text-muted)'
                  }}>
                    {turn.role === 'user' ? userCallName : turn.role === 'system' ? 'System' : personaName}
                  </span>
                  {turn.isFinal && <i className="ph ph-check-circle" style={{ fontSize: '12px', color: 'var(--accent-active)', opacity: 0.5 }}></i>}
                </div>
                <div style={{ fontSize: '14px', lineHeight: '1.6', color: 'var(--text-main)' }}>
                  <ReactMarkdown>{turn.text}</ReactMarkdown>
                </div>
              </div>
            ))
          )}
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
            {authError && <div style={{color:'red', marginBottom:'10px', fontSize:'14px'}}>{authError}</div>}
            {isSignupMode && (
               <div className="auth-input-wrapper">
                 <i className="ph ph-user auth-icon-left"></i>
                 <input type="text" placeholder="Full name" value={name} onChange={e => setName(e.target.value)} />
               </div>
            )}
            <div className="auth-input-wrapper">
              <i className="ph ph-envelope auth-icon-left"></i>
              <input type="email" placeholder="Email" required value={email} onChange={e => setEmail(e.target.value)} />
            </div>
            <div className="auth-input-wrapper">
              <i className="ph ph-lock auth-icon-left"></i>
              <input type="password" placeholder="Password" required value={password} onChange={e => setPassword(e.target.value)} />
            </div>
            {isSignupMode && (
                <div className="auth-input-wrapper">
                   <i className="ph ph-lock auth-icon-left"></i>
                   <input type="password" placeholder="Confirm password" />
                </div>
            )}
            <button type="submit" className="auth-submit-btn">{isSignupMode ? 'Sign up' : 'Sign in'}</button>
          </form>

          <div className="auth-divider"><span>or</span></div>

          <button className="btn-google" onClick={handleGoogleLogin}>
            <div className="g-icon-circle">G</div>
            Continue with Google
          </button>

          <div className="permissions-note">
            <span style={{ display: 'flex', alignItems: 'center', gap: '4px', fontWeight: 500, color: '#aaa' }}><i className="ph-fill ph-shield-check" style={{color: 'var(--accent-active)'}}></i> Authorization & Capabilities</span>
            <ul style={{ margin: 0, paddingLeft: '16px', textAlign: 'left', display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <li><strong>Google Workspace:</strong> Access to Gmail, Drive, Calendar, Contacts, and Tasks.</li>
              <li><strong>Live Web Search:</strong> Real-time Google Search access.</li>
              <li><strong>Function Tools:</strong> Automation capabilities across your synced apps.</li>
            </ul>
            <div style={{ marginTop: '12px', display: 'flex', gap: '8px', alignItems: 'flex-start', textAlign: 'left', background: 'rgba(0,0,0,0.2)', padding: '10px', borderRadius: '8px', border: '1px solid var(--border-color)' }}>
              <input type="checkbox" id="consent" checked={hasConsented} onChange={(e) => setHasConsented(e.target.checked)} style={{ marginTop: '4px', cursor: 'pointer' }} />
              <label htmlFor="consent" style={{ color: '#fff', cursor: 'pointer', fontSize: '13px', lineHeight: '1.4' }}>I explicitly grant permission to allow Eburon to access the Google Workspace APIs listed above, perform web searches, and utilize function tools on my behalf.</label>
            </div>
          </div>

          <div className="auth-toggle">
            {isSignupMode ? 'Back to ' : 'Don\'t have an account? '}
            <span onClick={() => setIsSignupMode(!isSignupMode)}>
              {isSignupMode ? 'Sign in' : 'Sign up'}
            </span>
          </div>

        </div>
      </div>

      {/* Memory Confirmation Modal */}
      {pendingMemory && (
        <div className="confirm-modal-overlay" style={{
           position: 'fixed',
           top:0, left:0, right:0, bottom:0,
           backgroundColor: 'rgba(0,0,0,0.85)',
           zIndex: 2000,
           display: 'flex',
           alignItems: 'center',
           justifyContent: 'center',
           padding: '20px'
        }}>
           <div className="confirm-modal" style={{
             backgroundColor: 'var(--bg-card)',
             width: '100%',
             maxWidth: '400px',
             borderRadius: '16px',
             border: '1px solid var(--border-color)',
             overflow: 'hidden',
             boxShadow: '0 20px 40px rgba(0,0,0,0.4)',
             animation: 'slideUp 0.3s ease-out'
           }}>
             <div style={{ padding: '20px', borderBottom: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h3 style={{ fontSize: '16px', fontWeight: 600 }}>Save to Memory?</h3>
                <button title="Dismiss memory" onClick={() => setPendingMemory(null)} style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}><i className="ph ph-x"></i></button>
             </div>
             <div style={{ padding: '24px' }}>
                <p style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '16px' }}>Beatrice wants to store a new memory of this insight:</p>
                <div className="memory-preview-box" style={{ 
                   padding: '16px', 
                   borderRadius: '12px', 
                   background: 'rgba(255,255,255,0.03)', 
                   fontSize: '14px', 
                   lineHeight: '1.6',
                   marginBottom: '24px', 
                   fontStyle: 'italic', 
                   borderLeft: '4px solid var(--accent-active)',
                   color: '#fff',
                   position: 'relative'
                }}>
                   <i className="ph ph-quotes" style={{ position: 'absolute', right: '12px', top: '12px', opacity: 0.1, fontSize: '24px' }}></i>
                   "{pendingMemory.content}"
                </div>
                
                <div className="form-group" style={{ marginBottom: '28px' }}>
                   <label style={{ fontSize: '11px', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '10px', display: 'block', color: 'var(--text-muted)' }}>Classify this Memory</label>
                   <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px' }}>
                      {['personal', 'work', 'project'].map(cat => (
                         <button 
                           key={cat}
                           className={`cat-btn ${newMemoryType === cat ? 'active' : ''}`}
                           style={{
                              padding: '10px',
                              borderRadius: '8px',
                              border: `1px solid ${newMemoryType === cat ? 'var(--accent-active)' : 'var(--border-color)'}`,
                              background: newMemoryType === cat ? 'rgba(203,251,69,0.1)' : 'transparent',
                              color: newMemoryType === cat ? 'var(--accent-active)' : 'var(--text-muted)',
                              fontSize: '12px',
                              textTransform: 'capitalize',
                              cursor: 'pointer',
                              transition: 'all 0.2s'
                           }}
                           onClick={() => setNewMemoryType(cat)}
                         >
                           {cat}
                         </button>
                      ))}
                   </div>
                </div>

                <div style={{ display: 'flex', gap: '12px' }}>
                   <button 
                     className="btn-secondary" 
                     style={{ flex: 1, padding: '12px', borderRadius: '12px', background: 'transparent', border: '1px solid var(--border-color)', color: 'var(--text-muted)' }}
                     onClick={() => setPendingMemory(null)}
                   >Discard</button>
                   <button 
                     className="btn-primary" 
                     style={{ flex: 1, padding: '12px', borderRadius: '12px', backgroundColor: 'var(--accent-active)', color: 'var(--bg-main)', fontWeight: 600 }}
                     onClick={() => {
                        handleConfirmPendingMemory(newMemoryType);
                     }}
                   >Save Memory</button>
                </div>
             </div>
           </div>
        </div>
      )}
    </div>
  );
}
