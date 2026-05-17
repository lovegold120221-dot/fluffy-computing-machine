# Repository Guidelines

## Project Structure & Module Organization

This is a Vite + React TypeScript app with an Express server entry.

- `server.ts` starts the API/server, serves Vite in development, and exposes `/api/*` routes for health, settings, conversations, memories, and uploads.
- `App.tsx`, `EburonApp.tsx`, and `index.tsx` are the main frontend entry points.
- `components/` contains UI modules: console tray, sidebar, header, modals, and demo screens.
- `contexts/` and `hooks/` hold React state providers and reusable browser/media hooks.
- `lib/` contains Gemini Live, audio, state, Firebase/Supabase, prompt, language, and tool helpers.
- `lib/worklets/` contains audio processors.
- `SCHEMA.sql`, `firestore.rules`, and `firebase-blueprint.json` document database/security setup.
- `dist/` is generated build output; do not edit it manually.

## Build, Test, and Development Commands

- `npm install` installs dependencies from `package-lock.json`.
- `npm run dev` starts `tsx server.ts` on port `3000` with Vite middleware.
- `npm run lint` runs ESLint across the repository, excluding `dist/`.
- `npm run build` builds the Vite frontend and bundles `server.ts` to `dist/server.cjs`.
- `npm start` runs the production bundle from `dist/server.cjs`.
- `npm run preview` serves the Vite build preview only; prefer `npm start` for full API validation.

## Coding Style & Naming Conventions

Use TypeScript for app and server code. Follow the existing 2-space indentation style in JSON/config files and keep React components in `PascalCase` (`Sidebar.tsx`, `ControlTray.tsx`). Hooks must use `use*` naming and live under `hooks/` when reusable. Shared helpers should match existing kebab-case names such as `audio-streamer.ts` and `genai-live-client.ts`. Use the `@/` alias for clear root imports.

## Testing Guidelines

No test runner is currently configured. Before submitting changes, run `npm run lint` and `npm run build`. For API changes, also run `npm run dev` and verify `/api/health`; authenticated routes require a Firebase ID token. If tests are added, colocate them as `*.test.ts` or `*.test.tsx`.

## Commit & Pull Request Guidelines

This checkout has no `.git` history, so commit conventions cannot be inferred locally. Use concise imperative commits, for example `Fix audio worklet registration`. Pull requests should include a summary, validation commands, linked issue/context, screenshots for UI changes, and notes for required env or schema updates.

## Security & Configuration Tips

Keep secrets in `.env.local` or deployment environment variables. Required integrations include `GEMINI_API_KEY`, Firebase project settings, and Supabase URL/key values. Never commit service-role keys, Firebase credentials, or local env files. When changing persistence behavior, update `SCHEMA.sql` and document migration steps in the PR.
