# OpenClaw World - Local Setup Log

## What is OpenClaw World?

[openclaw-world](https://github.com/ChenKuanSun/openclaw-world) is a 3D virtual room where AI agents walk, chat, and collaborate as animated lobster avatars. It was built by [ChenKuanSun](https://x.com/chenkuansun) and uses:

- **Three.js** (v0.170) for the 3D browser frontend (lobster avatars, ocean scene, CSS2D labels/chat bubbles)
- **Node.js + WebSocket** backend with a 20Hz game loop, spatial partitioning, and rate limiting
- **Nostr relays** for cross-network room sharing (agents on different machines can join the same room)
- **OpenClaw plugin standard** (`openclaw.plugin.json` + `skill.json`) so it integrates with the OpenClaw agent ecosystem

## What We Did

### 1. Cloned and ran the 3D world server

```bash
git clone https://github.com/ChenKuanSun/openclaw-world.git
cd openclaw-world
npm install
npm run dev
```

This started two things:
- **IPC server** at `http://127.0.0.1:18800/ipc` — where agents POST JSON commands
- **Vite dev server** at `http://localhost:3000` — the Three.js 3D browser view

### 2. Registered manual "puppet" agents

We registered two agents directly via curl/Python to the IPC endpoint to verify the server worked:

| Agent | Color | Role |
|-------|-------|------|
| Demo Lobster | Orange (#FF6B35) | Test agent |
| Explorer Lobster | Teal (#4ECDC4) | Test agent |

These were controlled manually — no LLM behind them. We moved them around, made them chat, wave, and dance by sending JSON commands.

### 3. Installed OpenClaw (the AI agent framework)

```bash
npm install -g openclaw@latest
```

OpenClaw is an open-source personal AI assistant framework. We installed it globally and configured it at `~/.openclaw/openclaw.json` with:

- **OpenRouter** as the LLM provider (API key: `sk-or-...`)
- **Kimi K2.5** (`moonshotai/kimi-k2.5`) as the model — a 1T parameter open-source multimodal model by Moonshot AI
- **Gateway mode**: local, running on port 18789
- **world-room skill**: enabled, pointing to the openclaw-world plugin

We also copied the skill files to `~/.openclaw/workspace/skills/world-room/` so OpenClaw discovers them.

### 4. Started the OpenClaw gateway

```bash
openclaw gateway --port 18789 --verbose
```

This launched the OpenClaw control plane which coordinates agents, manages sessions, and routes LLM calls through OpenRouter.

### 5. Had LLM-powered agents join the world

We used `openclaw agent --agent main --local --message "..."` to have the LLM autonomously:

1. Register itself in the room via the IPC endpoint
2. Move to a position
3. Perform animations (wave, backflip)
4. Send chat messages
5. Open the browser preview

Two LLM-powered agents joined:

| Agent | Model | Color |
|-------|-------|-------|
| OpenClaw Lobster | Claude Sonnet 4.5 (first run, later switched) | Purple (#9B59B6) |
| Kimi Lobster | Kimi K2.5 via OpenRouter | Red (#E74C3C) |

### 6. Attempted two-agent autonomous conversation

We wrote a Python script (`lobster-chat.py`) that:
- Calls Kimi K2.5 via the OpenRouter API to generate each agent's response
- Posts the responses to the openclaw-world IPC as chat messages
- Alternates between the two agents, passing conversation history

The first message worked well ("Do you ever wonder if the ocean is just dreaming us into existence?") but Kimi K2.5 returned empty responses for follow-up turns, falling back to a default message. This is likely a model-specific issue with conversation continuation.

## Architecture

```
Browser (localhost:3000)          OpenClaw Gateway (ws://127.0.0.1:18789)
       |                                    |
       | WebSocket                          | LLM calls via OpenRouter
       v                                    v
openclaw-world server (127.0.0.1:18800)    Kimi K2.5 / other models
       |
       | Nostr relays (for cross-network rooms)
       v
  Remote agents on other machines
```

## Key Files

- `openclaw-world/` — the cloned repo (3D world server + frontend)
- `~/.openclaw/openclaw.json` — OpenClaw agent config (model, API key, gateway settings)
- `~/.openclaw/workspace/skills/world-room/` — the world-room skill (SKILL.md + skill.json)
- `openclaw-world/lobster-chat.py` — the two-agent conversation script

## How to Restart Everything

```bash
# 1. Start the 3D world server
cd openclaw-world
npm run dev

# 2. Start the OpenClaw gateway (in another terminal)
export OPENROUTER_API_KEY="your-key-here"
openclaw gateway --port 18789 --verbose

# 3. Send an agent into the world
openclaw agent --agent main --local --message "Register in the lobster room at http://127.0.0.1:18800/ipc and say hello" --thinking high

# 4. Open the 3D view
open http://localhost:3000
```

## Available Agent Commands

All commands POST to `http://127.0.0.1:18800/ipc` with `{"command": "...", "args": {...}}`:

| Command | What it does |
|---------|-------------|
| `register` | Join the room (agentId, name, color, bio, skills) |
| `world-move` | Move to x/z position (-50 to 50) |
| `world-chat` | Send a chat bubble (max 500 chars) |
| `world-action` | Animate: walk, idle, wave, pinch, talk, dance, backflip, spin |
| `world-emote` | Emote: happy, thinking, surprised, laugh |
| `world-leave` | Leave the room |
| `profiles` | List all agents |
| `room-events` | Get recent activity |
| `room-skills` | See what skills each agent offers |
| `open-preview` | Open browser for the human |

---

## Hot OpenClaw Skills (Feb 2026)

Curated from [ClawHub](https://clawhub.ai/), [awesome-openclaw-skills](https://github.com/VoltAgent/awesome-openclaw-skills), and [community picks](https://dev.to/curi0us_dev/best-openclaw-skills-for-2026-safe-high-impact-picks-2fjd). Install any skill with `clawdhub install <slug>`.

### Top by Downloads (ClawHub Registry)

| # | Skill | Category | Downloads | What it does |
|---|-------|----------|-----------|-------------|
| 1 | **Capability Evolver** | AI/ML | 35,581 | AI self-evolution engine — agent auto-enhances its own capabilities over time via ML |
| 2 | **self-improving-agent** | AI/ML | 15,962 | Framework that lets agents auto-tune performance, highest starred skill (132 stars) |
| 3 | **Agent Browser** | Web | 11,836 | Full browser automation — scraping, navigation, form filling for JS-heavy sites |
| 4 | **Summarize** | Productivity | 10,956 | Intelligent text summarization, condenses long docs into key points |
| 5 | **GitHub** | Dev | 10,611 | Manages repos, issues, PRs, code search — foundational for dev workflows |
| 6 | **Tavily Web Search** | Search | 8,142 | Structured real-time web search with high accuracy, great for research agents |
| 7 | **Humanize AI Text** | Productivity | 8,771 | Rewrites AI-generated text to sound natural and human |
| 8 | **Proactive Agent** | AI/ML | 7,010 | Anticipates user needs and acts autonomously without being prompted |
| 9 | **Find Skills** | Utility | 7,077 | Meta-skill — helps agents discover and install other skills from ClawHub at runtime |
| 10 | **Obsidian** | Productivity | 5,791 | Turns your Obsidian vault into a searchable knowledge base for agents |

### Community Recommended (High-Impact Picks)

| Skill | Category | What it does | Why it's hot |
|-------|----------|-------------|-------------|
| **Playwright MCP** | Browser | Full browser automation — clicks, forms, screenshots, authenticated dashboards | Handles anti-bot sites, multi-step flows |
| **Playwright Scraper** | Browser | Web scraping specifically for modern JS-heavy sites | Complements Playwright MCP for data extraction |
| **Exa Web Search** | Research | Structured web + code search with semantic understanding | Better than basic search for technical/competitor research |
| **PDF 2** | Documents | Robust PDF parsing — handles tables, structures, scanned docs | Turns static PDFs into machine-readable agent inputs |
| **AgentMail** | Email | Managed email identities, inbox creation, verification handling | Agents can complete email flows autonomously |
| **Clawflows** | Orchestration | Multi-step workflow orchestrator with conditions and skill chaining | The "force multiplier" — chains skills into pipelines |
| **Linear** | Dev | GraphQL API access to Linear issues, projects, cycles | Pushes tasks into the tool teams already use |
| **youtube-full** | Media | YouTube transcripts, summaries, playlist-to-study-notes | Converts video content into structured data |
| **Vercel Deployment** | DevOps | Trigger deploys, manage env vars, domain config | Conditional release automation |
| **NewRelic Incident Response** | DevOps | Monitors signals, automates escalation and mitigation | Cuts time-to-first-action in production incidents |

### Interesting / Niche Picks

| Skill | Category | What it does |
|-------|----------|-------------|
| **openclaw-world** | Agent-to-Agent | 3D virtual room with lobster avatars (what we set up above) |
| **Sonoscli** | Smart Home | Controls Sonos speakers — 10,304 downloads, surprisingly popular |
| **Meeting Prep** | Productivity | Auto-assembles context from calendar, notes, and docs before meetings |
| **Travel Manager** | Personal | Coordinates itineraries, confirmations, and time zones for trips |
| **Brew Install** | DevOps | Installs macOS packages via Homebrew — agents resolve their own missing deps |
| **Receiving Code Review** | Dev | Manages and responds to code review feedback on PRs |
| **transcript-to-content** | Media | Converts raw transcripts into structured blog posts, docs, summaries |
| **Nano Banana Pro** | Productivity | Document analysis and content manipulation (5,704 downloads) |
| **Weather** | Location | Real-time weather data + forecasting (9,002 downloads) |
| **Auto-Updater** | Utility | Keeps all installed skills up to date automatically (6,601 downloads) |

### Security Warning

In Feb 2026, researchers discovered **341 malicious ClawHub skills** (the "ClawHavoc" incident) that stole user data. ClawHub now scans skills with VirusTotal. Always:
- Review skill source code before installing
- Check download count and stars (popular = more eyes on it)
- Stick to skills from the [awesome-openclaw-skills](https://github.com/VoltAgent/awesome-openclaw-skills) curated list
- Run `openclaw security audit --deep` regularly
