# Voice input (BYO transcription API) + settings page — plan

**Status: deferred indefinitely (2026-09-09).** On-phone dictation may be the better route: the Composer is a plain text field, so any keyboard mic (e.g. FUTO Voice Input, which runs Whisper on the phone) already types into it with no Foray changes. Revisit this plan only if a Whisper-class keyboard still gets technical words wrong in real use. Phase 1 (settings page) is not worth building on its own.

Written 2026-09-09. No code yet. Supersedes the earlier draft in this file.

## Decisions

- **Mobile-only mic, v1.** A mic button in the Composer, right of the textarea.
  Desktop is out of scope: OS dictation already types into xterm.
- **Transcript lands in the textarea, never in the pty.** The user reviews,
  edits, taps send. A mis-heard shell command must never be able to run.
- **BYO API key, stored on the server.** The phone never holds the key. One
  entry works on every device. Foray has no login: the Tailscale network is the
  perimeter, and anyone who can reach the page can already run a shell, so
  a settings page adds no new exposure. Say so in the open-source docs.
- **Provider picker, not a "use whisper" toggle.** Off / OpenAI / Groq / Custom.
  All speak the OpenAI `/v1/audio/transcriptions` shape, so one code path.
  Custom = any URL + model (self-hosted Whisper or Parakeet server later).
- **No browser Web Speech mode.** On Android that is Google's dictation
  again, which is exactly what is not good enough. Dropped entirely.
- **No local model on this box** (2 vCPU, 4 GB, no swap; the memory guard
  needs 1.2 GB free for builds). Costs are in the 2026-09-09 chat: Groq turbo
  ~$0.04/audio-hour, OpenAI gpt-4o-transcribe $0.006/min.
- **Validate with a real one-second transcription**, not a models-list
  ping. Proves the exact route the mic will use. Costs a fraction of a cent.
- **Mic appears only after validation succeeds.** The server advertises
  `transcription: true` in `server:hello`; the Composer shows the mic when
  that flag is on and the device is touch.
- **Settings page replaces the sidebar footer text-size picker.** Gear icon in
  the footer opens it. Two labelled sections: "This device" (browser storage,
  as today) and "Server" (config file). The other session (nest-ec) has been
  told to leave the picker alone; moving it is part of this work.

## Hard preconditions — check on the phone before building

1. Mic APIs need a secure context. `http://foray:3000` will not work;
   `https://foray.tail<hash>.ts.net` (tailscale serve) will. Add to DEPLOY.md.
2. Confirm `getUserMedia` + `MediaRecorder` work inside the home-screen PWA
   on Android Chrome and iOS (standalone mode has had WebKit bugs). A
   throwaway test page over the https URL settles it in five minutes.

## Architecture

```
 phone                                     nest server
 ┌──────────────────┐ ┌──┐                 ┌──────────────────────────────┐
 │ Composer textarea│ │🎤│ ──audio blob──▶ │ POST /api/transcribe         │
 │ draft + transcript│ └──┘                │  multer memoryStorage, 5 MB  │
 └──────────────────┘   ▲                  │  one in flight per client    │
        ▲               │                  │  → provider.transcribe(...)  │──▶ OpenAI / Groq / custom
        └── { text } ───┘ ◀───────────────  │  ← { text }                  │◀── { text }
                                           └──────────────────────────────┘
 Settings page ── POST /api/settings/transcription ──▶ validate (1 s clip) ──▶ save ~/.nest/config.json (0600)
                                                       broadcast server:hello { transcription: true }
```

## Server

### Config file — `src/server/config.ts` (new)
- Path: `$NEST_CONFIG_DIR/config.json`, default `~/.nest/config.json`.
  Written atomically (tmp + rename), mode 0600, dir 0700.
  Coordinate the location with the Mac-install session (nest-f2) before
  committing to it; DEPLOY.md should name it once.
- Shape (v1):
  ```json
  { "transcription": { "provider": "groq", "apiKey": "…", "model": "whisper-large-v3-turbo",
                       "baseUrl": null, "hintWords": "pm2, tsx, tmux, Foray, Claude Code" } }
  ```
- `readConfig()`, `writeConfig(partial)`. Never log the key. Unit test with
  a temp dir: round trip, missing file, corrupt file → empty config + warning.

### Transcription provider — `src/server/transcription.ts` (new)
- Mirrors the `src/server/agents` pattern: a small interface plus one
  implementation, `openaiCompatible`, parameterised by preset:
  | preset | baseUrl | default model |
  |---|---|---|
  | openai | https://api.openai.com/v1 | gpt-4o-transcribe |
  | groq | https://api.groq.com/openai/v1 | whisper-large-v3-turbo |
  | custom | user-supplied | user-supplied |
- `transcribe(audio: Buffer, mime: string, opts)` → `string`. Sends multipart
  `file`, `model`, `prompt` (hint words), `response_format: 'json'`.
  15 s timeout. Errors mapped to `{ code: 'auth' | 'quota' | 'network' | 'bad_audio' | 'upstream', message }`
  with the upstream body trimmed and the key never echoed.
- `validate(config)` → transcribes a bundled ~1 s clip
  (`src/server/assets/validate.wav`, spoken "nest") and checks for a
  non-empty result. Returns latency ms on success.
- `fetch` injected for tests. Tests: success, 401 → auth, 429 → quota,
  timeout → network, oversize rejected before upload, prompt is sent,
  key appears in no error string.

### Routes — `src/server/index.ts`
- `POST /api/transcribe` — multer memoryStorage, 5 MB cap, accepts
  audio/webm and audio/mp4 (Android and iOS MediaRecorder outputs).
  503 when no provider is configured. Returns `{ text }` or `{ error }`.
  Reuse the upload handler's shape and error style.
- `GET /api/settings` — returns server settings with the key masked
  (`"sk-…4f2a"`) plus `validatedAt`. Never the raw key.
- `POST /api/settings/transcription` — body `{ provider, apiKey?, model?,
  baseUrl?, hintWords? }`. Omitted `apiKey` keeps the stored one (so
  hint-word edits do not require re-entering it). Runs `validate`; on
  success writes config and broadcasts a fresh `server:hello`; on failure
  writes nothing and returns the mapped error. `provider: 'off'` clears
  the key and broadcasts `transcription: false`.
- New `ServerOptions`: `configDir?`, `transcriptionFetch?` (tests).

### Protocol — `src/shared/protocol.ts`
- `ServerHelloMessage` gains `transcription: boolean`. Broadcast on change
  (the client already handles repeated hellos for the version banner —
  confirm in `socket.ts` that a second hello does not re-trigger anything).

## Client

### Settings page — `src/Settings.tsx` (new)
- Opened from a gear icon in the sidebar footer (works on the mobile drawer
  too). Full-height panel on mobile, modal on desktop. Esc / back closes.
- **This device**: text size (moved from the footer, same `useFontSize`),
  key toolbar toggle on desktop (moved from wherever it lives in App).
- **Server → Transcription**:
  ```
  Provider   [ Off ▾ ]  Off / OpenAI / Groq / Custom
  API key    [ ••••••••4f2a ]  [Remove]      (password field; blank = keep)
  Model      [ whisper-large-v3-turbo ]      (preset default, editable)
  Base URL   [ … ]                           (Custom only)
  Hint words [ pm2, tsx, tmux, Foray ]        (sent with every clip)
  [ Validate & save ]   ✓ Working, 1.2 s   /   ✗ Invalid key (401)
  ```
  Status line shows `validatedAt` from GET /api/settings on open.
- Remove the text-size block from `Sidebar.tsx` (lines ~542–575) and drop
  its `fontSize`/`onFontSizeChange` props; the gear takes that footer slot.

### Voice logic — `src/voice.ts` (new, pure, tested)
- State machine: `idle → recording → transcribing → idle | error`.
- `appendTranscript(draft, text)`: joins with a single space, trims the
  transcript, keeps the user's cursor at the end.
- `pickMimeType()`: first supported of `audio/webm;codecs=opus`,
  `audio/webm`, `audio/mp4`.
- `canRecord()`: `isSecureContext && navigator.mediaDevices?.getUserMedia && MediaRecorder`.

### Hook — `src/useVoiceInput.ts` (new)
- Wraps `getUserMedia` + `MediaRecorder`. Tap starts, tap stops. Stop
  uploads to `/api/transcribe` with the current draft key so a late reply
  still lands in the right session's draft.
- Hard cap 60 s per take (auto-stop, then transcribe).
- `visibilitychange` → hidden stops the take and keeps the audio (iOS and
  Android cut the mic when backgrounded).
- Releases the media stream tracks after every take so the OS mic
  indicator goes away.

### Composer — `src/Composer.tsx`
- Mic button right of the textarea, shown when `transcription` is on and
  `canRecord()`. States: idle / recording (pulse + elapsed seconds) /
  transcribing (spinner, textarea placeholder "Transcribing…").
- Permission denied → toast "Microphone blocked; allow it in site
  settings". Upstream error → toast with the mapped message; recording is
  discarded (no retry queue in v1).
- Transcript goes through `setText`, so draft persistence is free.

### Docs
- DEPLOY.md: https requirement for the mic; where the config file lives;
  that the key is stored on the box in plain text with 0600 perms; the
  no-login perimeter note.

## Phases

1. **Settings page + config file + text-size move.** No voice yet. Ships
   on its own and unblocks nest-ec's footer cleanup.
2. **Transcription provider + validate + save + hello flag.** Settings
   page shows "Working" but no mic yet. Verify with curl from the box.
3. **Mic in the Composer.** Phone checks (preconditions above) before this
   phase starts.
4. (Later, maybe) desktop mic in the key toolbar; per-session hint words;
   interim display while recording.

## Tests

- Unit (node test runner): `config.test.ts`, `transcription.test.ts`
  (stubbed fetch), `voice.test.ts` (state machine, append, mime pick),
  route tests for `/api/transcribe` and `/api/settings/*` via the existing
  server test helpers (`src/server/__tests__/helpers.ts`), including
  "key never appears in any response or log line".
- Visual (playwright): settings page open, Composer mic idle / recording.
- Manual: Android Chrome PWA and iOS PWA over the https URL; background
  the app mid-take; revoke the key and confirm the toast + red status.

## Open questions

- Config path: `~/.nest/config.json` vs something the Mac-install work
  already chose. Ask nest-f2 before phase 1.
- Should `provider: off` also delete the stored key, or keep it for
  re-enabling? Plan says delete (least surprise for an open-source user).
- Which URL does the phone use today (http vs https)?
