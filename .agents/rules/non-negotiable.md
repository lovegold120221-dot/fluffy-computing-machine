---
trigger: always_on
---

# Non-Negotiable Coding Rules

## 1. Never edit unrelated files
Only modify the specific file(s) directly relevant to the requested change. Do not touch other components, hooks, styles, or utilities unless the task explicitly requires it.

## 2. Never remove existing functionality
When adding features, preserve all existing code paths, state variables, handlers, event listeners, UI elements, and CSS classes. Never delete or disable working code to make room for new code — layer additions on top.

## 3. Never write incomplete code
Every change must be complete and functional:
- All new exports/imports wired up
- All API client functions added
- All tool declarations added alongside handlers
- All UI elements properly integrated
- Build must pass before committing

## 4. Never assume — read first
Before editing any file, read its full contents or the relevant section. Do not guess variable names, function signatures, or existing patterns.

## 5. Never change architecture patterns
Match the existing code style: same import pattern, same error handling, same state management approach, same CSS conventions.

## 6. One feature, one scope per session
Do not expand scope beyond what was asked. If the user requests X, do not also fix Y, refactor Z, or improve A unless explicitly told.
