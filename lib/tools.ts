/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

import { FunctionResponseScheduling } from '@google/genai';
import { FunctionCall } from './state';
import { whatsappTools } from './tools/whatsapp-tools';
import { customerSupportTools } from './tools/customer-support';
import { navigationSystemTools } from './tools/navigation-system';
import { personalAssistantTools } from './tools/personal-assistant';

/**
 * All available function calling tools for Gemini Live audio integration.
 * Organized by domain: WhatsApp, Customer Support, Navigation, Personal Assistant.
 */
export const AVAILABLE_TOOLS: FunctionCall[] = [
  ...whatsappTools,
  ...customerSupportTools,
  ...navigationSystemTools,
  ...personalAssistantTools,
];
