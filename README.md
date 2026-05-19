# ChorusOps
### Voice-First AI Dealflow Orchestrator

> *"Every week, investment teams talk through dozens of pitches in meetings and voice calls. Almost none of it gets captured. The insight lives in the conversation — and then disappears."*

---

## The Problem

Venture capital teams evaluate startups through conversation — hallway chats, partner calls, voice meetings. But the tools they use are designed for after the meeting: spreadsheets, Notion docs, manually typed notes.

The result: critical context gets lost, analysis is inconsistent, and junior associates spend hours transcribing and formatting what should have been automated.

## Solution

**ChorusOps turns any voice conversation into a structured investment workflow — in real time, with zero manual input.**

Speak a pitch in a Discord voice channel. ChorusOps:
1. **Listens** and transcribes with full speaker attribution (S1, S2, S3...)
2. **Understands** the deal context using a central Gemini AI orchestrator
3. **Dispatches** deep analysis to an async Featherless.ai worker — while the conversation continues
4. **Speaks back** the verdict using Kokoro neural TTS — directly in your voice channel
5. **Logs everything** to a persistent web dashboard with pros, cons, scorecard, and deal history

The full loop: **Voice In → AI Brain → Voice Out**. No forms. No context-switching. No lost insight.

---

## Features

- 🎙️ **Real-time voice transcription** with speaker diarization — knows who said what (S1, S2, S3...)
- 🧠 **Gemini function-calling orchestrator** — plans steps, updates deal state, dispatches workers autonomously
- ⚡ **Async deep analysis worker** — Featherless DeepSeek-V3 runs investment analysis in the background while conversation continues
- 🔊 **Kokoro neural TTS** — bot speaks results back in the voice channel, 7 voice models switchable via `/voice`
- 💾 **Persistent JSON store** — all deals, transcripts, and scorecards survive backend restarts (`data/store.json`)
- 📊 **Live web dashboard** — real-time pipeline stages, pros/cons scorecard, deal history sidebar, browser speech synthesis
- 🔄 **Multi-guild isolation** — one deployment serves multiple Discord servers with full session separation
- 🗑️ **Workspace management** — create, switch, and delete deal workspaces from Discord or the web UI

---

## Who Is This For

**Primary users:** Venture capital partners, angel investors, and deal teams who evaluate startups through conversation — in meetings, partner calls, and voice channels.

**The workflow ChorusOps replaces:**

| Before ChorusOps | With ChorusOps |
|---|---|
| Junior associate manually transcribes meeting notes | Real-time speaker-attributed transcript, auto-logged |
| Analyst spends 2 hours writing deal memo | Deep analysis dispatched mid-conversation, ready in 15 seconds |
| Context lives in someone's memory or a messy doc | Structured scorecard (pros, cons, score, recommendation) persisted to dashboard |
| Next meeting starts with "wait, what did we say about them?" | Full deal history with search, one click away |

**Scale:** A single ChorusOps instance handles multiple concurrent guilds (investment teams), each with full session isolation. One deployment serves an entire firm.

---

## Live Demo

🚀 **Try the Live Replit Demo here:** [https://replit.com/@J4EDev/chorusops](https://replit.com/@J4EDev/chorusops)

```
You (voice):  "We're building a B2B logistics SaaS for last-mile delivery optimization. Three-person founding team of engineers and a former DHL operations lead. We're targeting a $4B market and raising $500K seed."
Bot (voice):  "Okay, I've noted the details for 'Logistics SaaS for Last-Mile Delivery Optimization,' including the team, market, and funding ask."
You (voice):  "Now for due diligence, run deep analysis on this deal."
Bot (voice):  "Deep analysis has been queued for this deal."
              ... 15 seconds ...
Bot (voice):  "Analysis complete. Score: 6/10. Recommendation: Pass."
```

![ChorusOps Discord Bot](discord.png)

![ChorusOps Dashboard](dashboard.png)

---

## Sponsor Technologies

| Layer | Technology | Why We Chose It |
|---|---|---|
| Speech-to-Text | [Speechmatics](https://speechmatics.com) | Best-in-class real-time speaker diarization — knows *who* said what |
| AI Planner | [Google Gemini](https://ai.google.dev) | Native function calling enables the tool-loop orchestration pattern |
| Analysis Worker | [Featherless.ai](https://featherless.ai) | Serverless LLM inference — no GPU setup, runs DeepSeek-V4-Flash on demand |
| Text-to-Speech | [Kokoro-Web](https://github.com/eduardolat/kokoro-web) | Self-hosted neural TTS — zero latency, zero rate limits, zero cost |

---

## Tech Stack

| Layer | Technology | Version |
|---|---|---|
| Runtime | Node.js | 18+ |
| Language | TypeScript | 5.x |
| Discord | discord.js + @discordjs/voice | 14.x |
| Audio decode | prism-media (Opus → PCM) | latest |
| AI Orchestrator | Google Gemini API (`@google/genai`) | 2.x |
| Analysis Worker | Featherless.ai (OpenAI-compatible) | — |
| Speech-to-Text | Speechmatics WebSocket API | v2 |
| Text-to-Speech | Kokoro-Web (self-hosted Docker) | latest |
| Backend | Express.js | 4.x |
| Database | In-memory + JSON persistence (`data/store.json`) | — |
| Frontend | Vanilla JS + HTML (no framework) | — |

---

## Architecture

```
Discord Voice Channel
        │
        ▼  Opus → PCM s16le (prism-media)
Speechmatics WebSocket (real-time STT + diarization)
        │  Speaker-attributed transcript turns
        ▼
Gemini Orchestrator  (function calling loop)
        ├── update_state()           log deal context incrementally
        ├── fetch_state()            read before dispatching
        └── enqueue_featherless_job()
                    │
                    ▼
        Featherless Worker  (DeepSeek-V4-Flash)
                    │  JSON: summary, pros, cons, score, recommendation
                    ▼
        Backend DB  (data/store.json — persistent across restarts)
                    │
          ┌─────────┴──────────┐
          ▼                    ▼
    Kokoro TTS            Web Dashboard
  (Voice Out in         (demo/index.html —
   voice channel)        live pipeline view)
```

---

## Prerequisites

- Node.js 18+
- Docker (for Kokoro TTS)
- API keys: Gemini, Speechmatics, Featherless.ai, Discord Bot Token

---

## Setup

### 1. Clone & configure

```bash
git clone https://github.com/JaePyJs/chorusops
cd chorusops
cp .env.example .env
```

Fill in `.env`:

```env
PORT=3000
BACKEND_URL=http://localhost:3000

GEMINI_API_KEY=your_gemini_key
SPEECHMATICS_API_KEY=your_speechmatics_key
FEATHERLESS_API_KEY=your_featherless_key
FEATHERLESS_BASE_URL=https://api.featherless.ai/v1
FEATHERLESS_MODEL=deepseek-ai/DeepSeek-V4-Flash
DISCORD_BOT_TOKEN=your_discord_token

TTS_ENABLED=true
TTS_BASE_URL=http://localhost:3001/api/v1
TTS_API_KEY=chorusops
TTS_VOICE=af_heart
```

### 2. Start Kokoro TTS (Docker)

```bash
docker run -d \
  --name chorusops-tts \
  -p 3001:3000 \
  -e KW_SECRET_API_KEY=chorusops \
  --restart unless-stopped \
  ghcr.io/eduardolat/kokoro-web:latest
```

### 3. Install & run

```bash
npm install

# Terminal 1 — backend + worker
npm run start:backend

# Terminal 2 — Discord bot
npm run start:bot
```

---

## Discord Commands

| Command | Description |
|---|---|
| `/join` | Bot joins your voice channel and starts listening |
| `/new` | Starts a brand-new, fresh deal workspace in this voice session |
| `/tts enabled:<true/false>` | Enable/disable bot voice playback in the channel |
| `/say <text>` | Send text directly to the Gemini orchestrator |
| `/status workflow_id:<id>` | Get full analysis results |
| `/leave` | Disconnect bot and clear session |

---

## Browser Demo (No Discord Required)

1. `npm run start:backend`
2. Open `demo/index.html` in your browser
3. Type deal pitches — watch the pipeline and scorecard update live

All conversations persist to `data/store.json` and survive backend restarts.

---

## Project Structure

```
chorusops/
├── backend/
│   ├── server.ts          # Express API server + REST endpoints
│   └── db.ts              # In-memory store with JSON persistence
├── bot/
│   ├── index.ts           # Discord bot, slash commands, voice pipeline
│   ├── speechmatics.ts    # Speechmatics WebSocket client
│   └── tts.ts             # Kokoro TTS integration
├── worker/
│   └── featherless.ts     # Featherless.ai deep analysis worker
├── demo/
│   └── index.html         # Browser demo dashboard (no framework)
├── data/                  # Runtime only — gitignored
│   └── store.json         # Persisted conversations, workflows, jobs
├── .env.example           # Environment variable template
├── package.json
└── tsconfig.json
```

---

## License

[MIT](LICENSE) © 2026 JaePyJs
