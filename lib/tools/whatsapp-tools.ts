/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

import { FunctionResponseScheduling } from '@google/genai';
import { FunctionCall } from '../state';

/**
 * WhatsApp function calling tools for Evolution API integration.
 * Enables the Gemini Live audio assistant to search, read, and send WhatsApp messages.
 */
export const whatsappTools: FunctionCall[] = [
  {
    name: 'send_whatsapp_message',
    description: 'Sends a WhatsApp message to a phone number using the Evolution API. Use this when the user asks you to send a message via WhatsApp.',
    parameters: {
      type: 'OBJECT',
      properties: {
        phoneNumber: {
          type: 'STRING',
          description: 'The recipient phone number (with country code, e.g., 639916188713).',
        },
        message: {
          type: 'STRING',
          description: 'The text content of the WhatsApp message to send.',
        },
        instanceName: {
          type: 'STRING',
          description: 'The Evolution instance name to use (e.g., beatrice). Defaults to beatrice if not specified.',
        },
      },
      required: ['phoneNumber', 'message'],
    },
    isEnabled: true,
    scheduling: FunctionResponseScheduling.INTERRUPT,
  },
  {
    name: 'search_whatsapp_messages',
    description: 'Searches WhatsApp messages from a specific contact or chat. Returns recent message history for the specified contact.',
    parameters: {
      type: 'OBJECT',
      properties: {
        phoneNumber: {
          type: 'STRING',
          description: 'The phone number of the contact to search messages from (e.g., 639916188713).',
        },
        query: {
          type: 'STRING',
          description: 'Optional search query to filter messages. Leave empty to get recent messages.',
        },
        limit: {
          type: 'INTEGER',
          description: 'Maximum number of messages to return. Defaults to 20.',
          enum: [5, 10, 20, 50],
        },
        instanceName: {
          type: 'STRING',
          description: 'The Evolution instance name to use (e.g., beatrice). Defaults to beatrice if not specified.',
        },
      },
      required: ['phoneNumber'],
    },
    isEnabled: true,
    scheduling: FunctionResponseScheduling.INTERRUPT,
  },
  {
    name: 'read_whatsapp_chat',
    description: 'Reads the recent chat history with a specific WhatsApp contact. Retrieves the conversation thread for reference.',
    parameters: {
      type: 'OBJECT',
      properties: {
        phoneNumber: {
          type: 'STRING',
          description: 'The phone number of the contact whose chat to read (e.g., 639916188713).',
        },
        limit: {
          type: 'INTEGER',
          description: 'Maximum number of messages to retrieve. Defaults to 30.',
          enum: [10, 20, 30, 50],
        },
        instanceName: {
          type: 'STRING',
          description: 'The Evolution instance name to use (e.g., beatrice). Defaults to beatrice if not specified.',
        },
      },
      required: ['phoneNumber'],
    },
    isEnabled: true,
    scheduling: FunctionResponseScheduling.INTERRUPT,
  },
  {
    name: 'get_whatsapp_status',
    description: 'Checks the connection status of the WhatsApp instance. Returns whether WhatsApp is connected and ready to send/receive messages.',
    parameters: {
      type: 'OBJECT',
      properties: {
        instanceName: {
          type: 'STRING',
          description: 'The Evolution instance name to check (e.g., beatrice). Defaults to beatrice if not specified.',
        },
      },
    },
    isEnabled: true,
    scheduling: FunctionResponseScheduling.INTERRUPT,
  },
  {
    name: 'get_whatsapp_contacts',
    description: 'Lists available WhatsApp contacts from the connected account. Returns a list of saved contacts with phone numbers and names.',
    parameters: {
      type: 'OBJECT',
      properties: {
        instanceName: {
          type: 'STRING',
          description: 'The Evolution instance name to use (e.g., beatrice). Defaults to beatrice if not specified.',
        },
        limit: {
          type: 'INTEGER',
          description: 'Maximum number of contacts to return. Defaults to 50.',
          enum: [10, 20, 50, 100],
        },
      },
    },
    isEnabled: true,
    scheduling: FunctionResponseScheduling.INTERRUPT,
  },
];
