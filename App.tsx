/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { LiveAPIProvider } from './contexts/LiveAPIContext';
import EburonApp from './EburonApp';

const API_KEY = process.env.GEMINI_API_KEY || '';

if (typeof API_KEY !== 'string' || API_KEY.length === 0) {
  console.error('Missing required environment variable: GEMINI_API_KEY');
}

/**
 * Main application component that provides a streaming interface for Live API.
 */
function App() {
  return (
    <LiveAPIProvider apiKey={API_KEY}>
      <EburonApp />
    </LiveAPIProvider>
  );
}

export default App;
