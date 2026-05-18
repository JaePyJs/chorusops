# Architecture: Voice-First Agentic Workflow System

## 1. Overview
This system is a voice-first Agentic Workflow platform built for a hackathon. It serves as an orchestrator that listens to users in a Discord voice channel, transcribes their speech in real-time, plans tasks using an LLM, and dispatches heavy or long-running work to a specialized async worker. 

**Domain chosen:** **Dealflow Orchestrator** - Evaluates startup pitches or investment deals by listening to a team discuss the deal, automatically triggering deep analysis (e.g., market research, financial sanity checks), and returning structured insights.

## 2. Technology Stack & Language Choice

**Proposed Language/Ecosystem:** **TypeScript (Node.js)**
**Justification:**
- **Discord Voice Integration:** `@discordjs/voice` is the industry standard for stable, reliable audio capture and playback in Discord. Python's `discord.py` officially dropped voice-receiving capabilities in its main branch, requiring third-party forks.
- **Unified Ecosystem:** Using Node.js allows both the Discord Bot and the Backend Service to share identical types, state schemas, and utility functions within a monorepo setup.
- **Tooling:** Express handles HTTP easily, and the official Google Gen AI SDK (`@google/genai`) and OpenAI SDK (for Featherless) have excellent TypeScript support.

## 3. Core Components

### A. Backend API (Express + TypeScript)
The central hub for state and routing.
- **Framework:** Express.js
- **State Store:** **In-memory** (using a TypeScript `Map`-based store in `backend/db.ts`). This is intentional for the hackathon demo — it is trivially replaceable with SQLite + Drizzle/Prisma for production.
- **Responsibilities:** 
  - Manage application state (Conversations, Workflows, Jobs) in-memory or SQLite.
  - Coordinate the Gemini orchestration loop.
  - Expose API endpoints for bot interaction.
- **Endpoints:**
  - `POST /agent/invoke`: Main entrypoint. Receives user transcripts (from Discord/Speechmatics) or text messages. Injects them into Gemini, handles tool calls, and returns the agent's immediate response.
  - `GET /agent/status/:workflow_id`: Returns workflow/job status.
  - `GET /health`: Basic health check.

### B. Gemini Orchestrator (Google AI Studio)
The "brain" of the agent.
- **Role:** Central planner. Maintains conversation context, decides whether to reply directly or spawn a multi-step task via function calling.
- **Tools Available to Gemini:**
  - `update_state(state_delta)`: Modifies the current workflow state (e.g., mark stage as "planning", "analyzing").
  - `fetch_state(keys)`: Retrieves current context.
  - `enqueue_featherless_job(payload)`: Submits a heavy task (e.g., "Deep Market Analysis") to the async queue.

### C. Async Worker (Featherless AI)
The heavy-lifter for domain-specific tasks.
- **Role:** Picks up jobs queued by Gemini, runs them against a specialized model hosted on Featherless.
- **Flow:** 
  - Polls the job queue.
  - Receives `DEEP_ANALYSIS` job.
  - Uses OpenAI-compatible client pointed at Featherless.
  - Stores structured JSON results back into the DB, potentially triggering a webhook or Discord notification when done.

### D. Discord Bot Client (discord.js)
The user interface.
- **Role:** Listens, speaks, and relays information.
- **Voice Pipeline:** 
  - Connects to a voice channel.
  - Captures Opus-encoded audio from each speaking user.
  - Decodes Opus → PCM s16le at 48kHz/mono using `prism-media`.
  - Streams PCM chunks to **Speechmatics RT SDK** over WebSocket.
  - On `AddTranscript` events, pushes transcript + speaker label to the backend `/agent/invoke` endpoint.
- **Speaker Attribution:** Discord user IDs are mapped to Speechmatics speaker labels (`S1`, `S2`, …) on first detected speech. This mapping is stored in-process, enabling per-speaker attribution in the workflow state.
- **Text Pipeline:** Handles `!agent say` for text input, `!status <workflow_id>` for async job status checks.

### E. Speechmatics RT Configuration
Real-time STT is configured as follows in `bot/speechmatics.ts`, based on the [turn detection](https://docs.speechmatics.com/speech-to-text/realtime/turn-detection) and [auth](https://docs.speechmatics.com/introduction/authentication) docs:

**Auth**: API key as `Authorization: Bearer` header in the WebSocket handshake. This is the documented server-side pattern; JWT temp-keys are only needed for browser (client-side) connections.

**StartRecognition config**:
```json
{
  "audio_format": { "type": "raw", "encoding": "pcm_s16le", "sample_rate": 48000 },
  "transcription_config": {
    "language": "en",
    "operating_point": "enhanced",
    "enable_partials": false,
    "diarization": "speaker",
    "max_delay": 5,
    "conversation_config": {
      "end_of_utterance_silence_trigger": 0.5
    }
  }
}
```

**Turn detection**: `end_of_utterance_silence_trigger: 0.5` is the SMART_TURN equivalent. The server fires `EndOfUtterance` after 0.5s of silence, and the preceding `AddTranscript` event is forwarded to the Gemini planner. `enable_partials: false` prevents mid-sentence LLM calls.

**Speaker attribution**: `diarization: 'speaker'` causes each result's `alternatives[0].speaker` to contain a label (`S1`, `S2`, ...). Discord user IDs are mapped to these labels on first detected speech.

## 4. Data Flow

1. **Voice Input:** User speaks in Discord voice channel.
2. **Transcription:** Discord Bot streams audio to Speechmatics. Speechmatics returns text with `SMART_TURN` diarization.
3. **Invocation:** Bot POSTs text to `/agent/invoke` on the Backend.
4. **Planning:** Backend queries Gemini. Gemini uses tools (e.g., `enqueue_featherless_job`) to plan analysis.
5. **Async Processing:** Worker picks up the job from the queue, queries Featherless API, and saves the output.
6. **Response:** Gemini formulates a reply (e.g., "I've queued a deep analysis on that startup."), which the Bot posts in the Discord text channel. Later, the Bot checks job completion to notify the users of the final Featherless output.

## 5. Schema Outline

- **Conversations:** `id`, `channel_id`, `participants[]`
- **Workflows:** `id`, `conversation_id`, `type` (e.g. `DEAL_EVALUATION`), `status`, `state` (JSON with keys: `dealName`, `stage`, `teamNotes`, `marketNotes`, `ask`, `questions[]`, `jobId`, `recommendation`)
- **Jobs:** `id`, `workflow_id`, `type` (`DEEP_ANALYSIS`), `payload` (JSON: deal context), `status` (`PENDING` | `RUNNING` | `COMPLETED` | `FAILED`), `result` (structured JSON: risks, pros, cons, score, recommendation)
