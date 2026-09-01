# Repository guidance

This is a public learning repository. Never add company code, real user data, internal URLs, credentials, screenshots containing private information, or production configuration.

## Product rules

- Keep all demo organizations, tables, users, and data fictional.
- Preserve the module boundaries for sync tasks, data development, masking, and data assets.
- The first release simulates data movement. Do not claim that records were really copied.
- User-facing copy is Simplified Chinese. Code, API fields, and commit messages use English.

## Engineering rules

- Keep browser code, server code, shared validation, and persistence separated.
- Prefer the Node.js standard library for the MVP; add dependencies only with a clear product benefit.
- Validate every API input on the server.
- Add or update tests for behavior changes.
- Run `npm run ci` before handing off changes.
- Never commit `.env`, access keys, tokens, database passwords, or generated `.data` files.
