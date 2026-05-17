<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/fb9aa7a0-aed9-4244-9fc5-f3081d0f6985

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key.
3. Set Supabase server credentials in `.env.local`:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
4. Set Firebase client/server project variables in `.env.local`:
   - `VITE_FIREBASE_API_KEY`
   - `VITE_FIREBASE_AUTH_DOMAIN`
   - `VITE_FIREBASE_PROJECT_ID`
   - `VITE_FIREBASE_APP_ID`
5. Run `SCHEMA.sql` in the Supabase SQL Editor. This creates `user_profiles`, `conversation_sessions`, `user_conversations`, and `user_memories` keyed by Firebase `uid`.
6. Run the app:
   `npm run dev`

## Conversation Memory

Firebase Auth remains the identity source. On every authenticated API call, the server verifies the Firebase ID token, mirrors the current user into Supabase `user_profiles`, and stores/fetches conversations by `uid`.

- User, AI, and tool/system turns are saved to `user_conversations`.
- Turns are grouped by `conversation_sessions.session_id`.
- Long-term memory entries live in `user_memories`.
- `/api/conversations/context` returns the current user's profile, memories, and recent turns for live AI context injection.
