/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
/**
 * Copyright 2024 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GenAILiveClient } from '../../lib/genai-live-client';
import { LiveConnectConfig, Modality, LiveServerToolCall } from '@google/genai';
import { AudioStreamer } from '../../lib/audio-streamer';
import { audioContext } from '../../lib/utils';
import VolMeterWorket from '../../lib/worklets/vol-meter';
import { useLogStore, useSettings, useAuth } from '@/lib/state';
import { auth } from '@/lib/firebase';
import * as api from '@/lib/api-client';

export type UseLiveApiResults = {
  client: GenAILiveClient;
  setConfig: (config: LiveConnectConfig) => void;
  config: LiveConnectConfig;

  connect: () => Promise<void>;
  disconnect: () => void;
  connected: boolean;

  volume: number;
};

export function useLiveApi({
  apiKey,
}: {
  apiKey: string;
}): UseLiveApiResults {
  const { model } = useSettings();
  const client = useMemo(() => new GenAILiveClient(apiKey, model), [apiKey, model]);

  const audioStreamerRef = useRef<AudioStreamer | null>(null);

  const [volume, setVolume] = useState(0);
  const [connected, setConnected] = useState(false);
  const [config, setConfig] = useState<LiveConnectConfig>({});

  useEffect(() => {
    let isCancelled = false;
    if (!audioStreamerRef.current) {
      audioContext({ id: 'audio-out' }).then((audioCtx: AudioContext) => {
        if (isCancelled) return;
        if (audioStreamerRef.current) return;
        audioStreamerRef.current = new AudioStreamer(audioCtx);
        audioStreamerRef.current
          .addWorklet<any>('vumeter-out', VolMeterWorket, (ev: any) => {
            setVolume(ev.data.volume);
          })
          .then(() => {
            // Successfully added worklet
          })
          .catch(err => {
            console.error('Error adding worklet:', err);
          });
      });
    }
    return () => {
      isCancelled = true;
    };
  }, []);

  useEffect(() => {
    const onOpen = () => {
      setConnected(true);
    };

    const onClose = () => {
      setConnected(false);
    };

    const stopAudioStreamer = () => {
      if (audioStreamerRef.current) {
        audioStreamerRef.current.stop();
      }
    };

    const onAudio = (data: ArrayBuffer) => {
      if (audioStreamerRef.current) {
        audioStreamerRef.current.addPCM16(new Uint8Array(data));
      }
    };

    // Bind event listeners
    const onToolCall = async (toolCall: LiveServerToolCall) => {
      const functionResponses: any[] = [];

      for (const fc of toolCall.functionCalls) {
        // Log the function call trigger
        const triggerMessage = `Triggering function call: **${
          fc.name
        }**\n\`\`\`json\n${JSON.stringify(fc.args, null, 2)}\n\`\`\``;
        useLogStore.getState().addTurn({
          role: 'system',
          text: triggerMessage,
          isFinal: true,
        });

        let responsePayload: any = { result: 'ok' };
        
        if (fc.name === 'fetch_google_api') {
           const { url, method, body } = fc.args as any;
           const token = useAuth.getState().googleAccessToken;
           if (!token) {
               responsePayload = { error: 'No Google access token found, please authenticate with Google (Sign in option).' };
           } else if (!url) {
               responsePayload = { error: 'Missing full URL for Google API.' };
           } else {
               try {
                   const headers: any = { Authorization: `Bearer ${token}` };
                   let fetchBody = undefined;
                   if (body) {
                       headers['Content-Type'] = 'application/json';
                       fetchBody = typeof body === 'string' ? body : JSON.stringify(body);
                   }

                   const res = await fetch(url, {
                       method: method || 'GET',
                       headers,
                       body: fetchBody
                   });

                   let dataText = '';
                   try { dataText = await res.text(); } catch (e) {}

                   let json = null;
                   if (dataText) {
                       try { json = JSON.parse(dataText); } catch(e) {}
                   }
                   
                   if (!res.ok) {
                       responsePayload = { 
                           error: `HTTP Error ${res.status}: ${res.statusText}`, 
                           status: res.status,
                           details: json || dataText || 'No error body returned.'
                       };
                   } else {
                       responsePayload = {
                           data: json || dataText
                       };
                       // If meaningful response, set in UI workspace
                       if (json && Object.keys(json).length > 0) {
                           const uiState = await import('../../lib/state');
                           uiState.useUI.getState().setActiveWorkspaceResult(json);
                       }
                   }
               } catch (e: any) {
                   responsePayload = { error: 'Request execution failed. Network might be down or API blocked.', message: e.message };
               }
           }
        }

        if (fc.name === 'save_memory') {
           const { memory, type } = fc.args as any;
           const user = auth.currentUser;
           if (!user) {
               responsePayload = { error: 'No user authenticated. Cannot save memory.' };
           } else {
               try {
                   await api.saveMemory(memory, type || 'personal');
                   responsePayload = { status: 'Memory saved successfully' };
               } catch (e: any) {
                   console.error("Error saving memory to Postgres:", e);
                   responsePayload = { error: 'Failed to save memory' };
               }
           }
        }

        if (fc.name === 'generate_artifact') {
           const { title, type, content, language } = fc.args as any;
           responsePayload = { status: 'Artifact generated successfully', title };
           const uiState = await import('../../lib/state');
           uiState.useUI.getState().setActiveWorkspaceResult({
              artifact: { title, type, content, language }
           });
        }

        if (fc.name === 'create_calendar_event') {
          const { summary, location, startTime, endTime } = fc.args as any;
          const token = useAuth.getState().googleAccessToken;
          if (!token) {
            responsePayload = { error: 'No Google access token found, please authenticate.' };
          } else {
            try {
              const res = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
                method: 'POST',
                headers: { 
                  Authorization: `Bearer ${token}`,
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                  summary,
                  location,
                  start: { dateTime: startTime },
                  end: { dateTime: endTime }
                })
              });
              responsePayload = await res.json();
            } catch (e: any) {
              responsePayload = { error: e.message };
            }
          }
        }

        if (fc.name === 'send_email') {
          const { recipient, subject, body } = fc.args as any;
          const token = useAuth.getState().googleAccessToken;
          if (!token) {
            responsePayload = { error: 'No Google access token found, please authenticate.' };
          } else {
            try {
              // Gmail API uses base64url encoded RFC822 messages
              const utf8Encoder = new TextEncoder();
              const email = [
                `To: ${recipient}`,
                `Subject: ${subject}`,
                '',
                body
              ].join('\r\n');
              const encodedEmail = btoa(email).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
              
              const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
                method: 'POST',
                headers: { 
                  Authorization: `Bearer ${token}`,
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({ raw: encodedEmail })
              });
              responsePayload = await res.json();
            } catch (e: any) {
              responsePayload = { error: e.message };
            }
          }
        }

        if (fc.name === 'list_gmail_messages') {
          const { q } = fc.args as any;
          const token = useAuth.getState().googleAccessToken;
          if (!token) {
            responsePayload = { error: 'No Google access token found, please authenticate.' };
          } else {
            try {
              const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
              if (q) url.searchParams.append('q', q);
              const res = await fetch(url.toString(), {
                headers: { Authorization: `Bearer ${token}` }
              });
              responsePayload = await res.json();
            } catch (e: any) {
              responsePayload = { error: e.message };
            }
          }
        }

        if (fc.name === 'get_gmail_message') {
          const { id } = fc.args as any;
          const token = useAuth.getState().googleAccessToken;
          if (!token) {
            responsePayload = { error: 'No Google access token found, please authenticate.' };
          } else {
            try {
              const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}`, {
                headers: { Authorization: `Bearer ${token}` }
              });
              responsePayload = await res.json();
            } catch (e: any) {
              responsePayload = { error: e.message };
            }
          }
        }

        if (fc.name === 'list_calendar_events') {
          const { timeMin, timeMax } = fc.args as any;
          const token = useAuth.getState().googleAccessToken;
          if (!token) {
            responsePayload = { error: 'No Google access token found, please authenticate.' };
          } else {
            try {
              const url = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');
              if (timeMin) url.searchParams.append('timeMin', timeMin);
              if (timeMax) url.searchParams.append('timeMax', timeMax);
              const res = await fetch(url.toString(), {
                headers: { Authorization: `Bearer ${token}` }
              });
              responsePayload = await res.json();
            } catch (e: any) {
              responsePayload = { error: e.message };
            }
          }
        }

        if (fc.name === 'search_contacts') {
          const { query } = fc.args as any;
          const token = useAuth.getState().googleAccessToken;
          if (!token) {
            responsePayload = { error: 'No Google access token found, please authenticate.' };
          } else {
            try {
              const url = new URL('https://people.googleapis.com/v1/people/me/connections');
              url.searchParams.append('personFields', 'names,emailAddresses');
              const res = await fetch(url.toString(), {
                headers: { Authorization: `Bearer ${token}` }
              });
              const data = await res.json();
              if (query) {
                  // Simple client-side filtering
                  data.connections = data.connections?.filter((c: any) => 
                      c.names?.some((n: any) => n.displayName.toLowerCase().includes(query.toLowerCase()))
                  );
              }
              responsePayload = data;
            } catch (e: any) {
              responsePayload = { error: e.message };
            }
          }
        }

        if (fc.name === 'get_current_date') {
          responsePayload = { date: new Date().toISOString() };
        }

        if (fc.name === 'get_user_location') {
          try {
            const position = await new Promise<GeolocationPosition>((resolve, reject) => {
              navigator.geolocation.getCurrentPosition(resolve, reject);
            });
            responsePayload = {
              latitude: position.coords.latitude,
              longitude: position.coords.longitude,
              accuracy: position.coords.accuracy
            };
          } catch (e: any) {
            responsePayload = { error: e.message || 'Geolocation failed' };
          }
        }

        if (fc.name === 'search_places') {
          const { query, location } = fc.args as any;
          const token = useAuth.getState().googleAccessToken;
          // Places API usually uses API Key, but we can try to use the token if proxied or use the fetch tool
          // Actually, for consistency, we'll try to fetch it.
          try {
            // Using the Places API (New)
            const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.location'
              },
              body: JSON.stringify({
                textQuery: query,
                locationBias: location ? {
                  circle: {
                    center: {
                      latitude: parseFloat(location.split(',')[0]),
                      longitude: parseFloat(location.split(',')[1])
                    },
                    radius: 5000.0
                  }
                } : undefined
              })
            });
            responsePayload = await res.json();
          } catch (e: any) {
            responsePayload = { error: e.message };
          }
        }

        if (fc.name === 'list_contacts') {
          const { pageSize } = fc.args as any;
          const token = useAuth.getState().googleAccessToken;
          if (!token) {
            responsePayload = { error: 'No Google access token found.' };
          } else {
            try {
              const url = new URL('https://people.googleapis.com/v1/people/me/connections');
              url.searchParams.append('personFields', 'names,emailAddresses,phoneNumbers');
              url.searchParams.append('pageSize', (pageSize || 10).toString());
              const res = await fetch(url.toString(), {
                headers: { Authorization: `Bearer ${token}` }
              });
              responsePayload = await res.json();
            } catch (e: any) {
              responsePayload = { error: e.message };
            }
          }
        }

        // Prepare the response
        functionResponses.push({
          id: fc.id,
          name: fc.name,
          response: responsePayload,
        });
      }

      // Log the function call response
      if (functionResponses.length > 0) {
        const responseMessage = `Function call response:\n\`\`\`json\n${JSON.stringify(
          functionResponses,
          null,
          2,
        )}\n\`\`\``;
        useLogStore.getState().addTurn({
          role: 'system',
          text: responseMessage,
          isFinal: true,
        });
      }

      client.sendToolResponse({ functionResponses: functionResponses });
    };

    client.on('open', onOpen);
    client.on('close', onClose);
    client.on('interrupted', stopAudioStreamer);
    client.on('audio', onAudio);
    client.on('toolcall', onToolCall);

    return () => {
      // Clean up event listeners
      client.off('open', onOpen);
      client.off('close', onClose);
      client.off('interrupted', stopAudioStreamer);
      client.off('audio', onAudio);
      client.off('toolcall', onToolCall);
    };
  }, [client]);

  const connect = useCallback(async () => {
    if (!config) {
      throw new Error('config has not been set');
    }
    client.disconnect();
    await client.connect(config);
  }, [client, config]);

  const disconnect = useCallback(async () => {
    client.disconnect();
    setConnected(false);
  }, [setConnected, client]);

  return {
    client,
    config,
    setConfig,
    connect,
    connected,
    disconnect,
    volume,
  };
}