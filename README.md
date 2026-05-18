# Voice-First Agentic Workflow System: Dealflow Orchestrator

This project is a production-shaped, open-source **Agentic Workflow** system built for the hackathon. It serves as an AI orchestrator that listens to users in a Discord voice channel, transcribes their speech, plans tasks using an LLM, and dispatches heavy analytical tasks to a specialized asynchronous worker.

**Domain:** **Dealflow Orchestrator** - Evaluates startup pitches or investment deals by listening to a team discuss the deal, automatically triggering deep analysis (e.g., market research, financial sanity checks) and returning structured insights.

## Why this fits the Agentic Workflows Track

This system demonstrates a true multi-agent, asynchronous orchestration pattern rather than a simple chatbot:
- **Speechmatics** handles the raw sensing layer: Real-time STT with diarization enabled, so the agent receives speaker-attributed `AddTranscript` events instead of raw text fragments. We configure Speechmatics with `diarization: "speaker"` and `max_delay: 5` — approximating the SMART_TURN preset — so the agent receives clean, turn-length speaker-attributed segments (e.g. `S1`, `S2`) rather than raw streaming fragments.
- **Gemini API** acts as the Central Planner: It maintains conversational and workflow state over time. Using function calling (`update_state`, `enqueue_featherless_job`), it decides *when* to ask clarifying questions and *when* to kick off a multi-step background process.
- **Featherless AI** acts as the Domain-Specialized Asynchronous Worker: Long-running, compute-heavy tasks (like a "Deep Analysis" of a pitch against market data using an open-weights model) are processed in the background, without blocking the real-time voice interface.

For AI Week participants, this means that a full day of hallway conversations and pitch meetings can be transformed into a prioritized pipeline of opportunities, each with auto-generated risk/fit analysis and suggested next steps — all driven by natural voice conversation with no forms or manual data entry.

## Architecture

1. **Backend API (Express/TypeScript):** The central hub managing state (Conversations, Workflows, Jobs) and routing the orchestrator loop.
2. **Gemini Client:** Uses Google's `@google/genai` SDK to evaluate the context and trigger tools.
3. **Async Worker:** Polls the job queue and executes domain-specific prompts against **Featherless AI** via their OpenAI-compatible endpoint.
4. **Discord Bot Client:** Uses `@discordjs/voice` to capture raw PCM audio from users, pipes it into the **Speechmatics RT WebSocket API**, and relays text to the backend.

*(See `ARCHITECTURE.md` for more details)*

## Quickstart

### 1. Setup Environment
Clone the repo, then copy the environment template:
```bash
cp .env.example .env
```
Fill in the following in `.env`:
- `GEMINI_API_KEY`: From Google AI Studio
- `FEATHERLESS_API_KEY`: From Featherless.ai
- `SPEECHMATICS_API_KEY`: From Speechmatics Portal
- `DISCORD_BOT_TOKEN`: From Discord Developer Portal

### 2. Install Dependencies
```bash
npm install
```

### 3. Run the System
You need to start the backend and the discord bot. The backend automatically spawns the background worker for simplicity in this demo.

**Terminal 1 (Backend & Worker):**
```bash
npm run start:backend
```

**Terminal 2 (Discord Bot):**
```bash
npm run start:bot
```

### 4. Try the Flow
1. Invite your bot to a Discord server.
2. Join a Voice Channel.
3. Type `!agent join` in a text channel. The bot will join the voice channel.
4. Start speaking! Discuss a new startup pitch. (e.g., *"Let's talk about Startup X. They are building AI for logistics."*)
5. The bot transcribes your speech via Speechmatics and sends it to the Gemini backend.
6. Ask the agent to run an analysis: *"Can you run a deep analysis on Startup X?"*
7. Gemini will enqueue a Featherless job. You will see the worker pick it up in your backend terminal and output structured JSON results.
8. You can also interact via text using `!agent say [message]`.

## License
MIT
