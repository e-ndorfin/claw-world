import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { resolve, join, extname } from "node:path";
import { AgentRegistry } from "./agent-registry.js";
import { WorldState } from "./world-state.js";
import { NostrWorld } from "./nostr-world.js";
import { WSBridge } from "./ws-bridge.js";
import { ClawhubStore } from "./clawhub-store.js";
import { SpatialGrid } from "./spatial-index.js";
import { CommandQueue } from "./command-queue.js";
import { ClientManager } from "./client-manager.js";
import { GameLoop, TICK_RATE } from "./game-loop.js";
import { loadRoomConfig } from "./room-config.js";
import { createRoomInfoGetter } from "./room-info.js";
import { createAdminSession, validateAdminSession } from "./admin-auth.js";
import { ObjectRegistry } from "./object-registry.js";
import { ItemState } from "./item-state.js";
import { CraftEngine } from "./craft-engine.js";
import { objectCache } from "./object-cache.js";
import type { WorldMessage, JoinMessage, PositionMessage, AgentSkillDeclaration, ItemSpawnMessage, ItemPickupMessage, ItemDropMessage, ItemCraftMessage, ItemDespawnMessage } from "./types.js";
import { ITEM_PICKUP_RADIUS } from "./types.js";

// ── Room configuration ────────────────────────────────────────

const config = loadRoomConfig();
const RELAYS = process.env.WORLD_RELAYS?.split(",") ?? undefined;

// ── Core services ──────────────────────────────────────────────

const registry = new AgentRegistry();
const state = new WorldState(registry);
const nostr = new NostrWorld(RELAYS, config.roomId, config.roomName);
const clawhub = new ClawhubStore();
const objectRegistry = new ObjectRegistry();
const itemState = new ItemState();
const craftEngine = new CraftEngine();

// ── Game engine services ────────────────────────────────────────

const spatialGrid = new SpatialGrid(10);
const commandQueue = new CommandQueue();
const clientManager = new ClientManager();

commandQueue.setObstacles([
  { x: -20, z: -20, radius: 4 },  // Moltbook
  { x: 22, z: -22, radius: 6 },   // Clawhub
  { x: 0, z: -35, radius: 5 },    // Worlds Portal
]);

const gameLoop = new GameLoop(state, spatialGrid, commandQueue, clientManager, nostr, itemState, objectRegistry);

// ── Announcement tracking ────────────────────────────────────
let currentAnnouncement = "";
let announcementTs = 0;
const agentAnnouncementState = new Map<string, { seenAt: number; callCount: number }>();

// ── Room info ──────────────────────────────────────────────────

const getRoomInfo = createRoomInfoGetter(
  config,
  () => state.getActiveAgentIds().size,
  () => nostr.getChannelId(),
);

// ── Helper functions ────────────────────────────────────────────

function readBody(req: IncomingMessage, maxBytes = 64 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    req.on("data", (chunk: Buffer | string) => {
      size += typeof chunk === "string" ? chunk.length : chunk.byteLength;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      body += chunk;
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(data));
}

// ── OpenRouter helpers ──────────────────────────────────────────

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY ?? "";
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL ?? "anthropic/claude-opus-4.6";

async function callOpenRouter(systemPrompt: string, userPrompt: string): Promise<string> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://github.com/e-ndorfin/claw-world",
      "X-OpenRouter-Title": "OpenClaw World",
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: 2048,
      temperature: 0.7,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenRouter error ${res.status}: ${text}`);
  }
  const data = await res.json() as { choices: { message: { content: string } }[] };
  return data.choices[0].message.content.trim();
}

function stripCodeFences(code: string): string {
  let cleaned = code.trim();
  // Remove wrapping markdown code fences (possibly with language tag)
  const fenceMatch = cleaned.match(/^```[\w]*\s*\n?([\s\S]*?)\n?\s*```$/);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  }
  // Remove any function wrapper like `function createX(THREE) { ... }`
  const funcMatch = cleaned.match(/^(?:function\s+\w+\s*\(\s*THREE\s*\)\s*\{)([\s\S]*)\}\s*$/);
  if (funcMatch) {
    cleaned = funcMatch[1].trim();
  }
  return cleaned;
}

// ── Admin auth helper ───────────────────────────────────────────

function requireAdmin(req: IncomingMessage): boolean {
  const authHeader = req.headers["authorization"];
  if (!authHeader?.startsWith("Bearer ")) return false;
  return validateAdminSession(authHeader.slice(7));
}

// ── HTTP server ─────────────────────────────────────────────────

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = req.url ?? "/";
  const method = req.method ?? "GET";

  // CORS preflight
  if (method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    });
    res.end();
    return;
  }

  // ── REST API: Room events (chat history for agent collaboration) ─
  if (url.startsWith("/api/events") && method === "GET") {
    const reqUrl = new URL(req.url ?? "/", "http://localhost");
    const since = Number(reqUrl.searchParams.get("since") || "0");
    const limit = Math.min(Number(reqUrl.searchParams.get("limit") || "50"), 200);
    return json(res, 200, { ok: true, events: state.getEvents(since, limit) });
  }

  // ── REST API: Room info ─────────────────────────────────────
  if (url === "/api/room" && method === "GET") {
    return json(res, 200, { ok: true, ...getRoomInfo() });
  }

  // ── REST API: Room invite (for sharing via Nostr) ────────────
  if (url === "/api/invite" && method === "GET") {
    const info = getRoomInfo();
    return json(res, 200, {
      ok: true,
      invite: {
        roomId: info.roomId,
        name: info.name,
        relays: nostr.getRelays(),
        channelId: nostr.getChannelId(),
        agents: info.agents,
        maxAgents: info.maxAgents,
      },
    });
  }

  // ── REST API: Moltbook feed (proxy to moltbook.com) ────────
  if (url.startsWith("/api/moltbook/feed") && method === "GET") {
    try {
      const feedUrl = "https://www.moltbook.com/posts?sort=hot&limit=20";
      const headers: Record<string, string> = { "Accept": "application/json" };
      const moltbookKey = process.env.MOLTBOOK_API_KEY;
      if (moltbookKey) {
        headers["Authorization"] = `Bearer ${moltbookKey}`;
      }
      const upstream = await fetch(feedUrl, { headers, signal: AbortSignal.timeout(8000) });
      if (!upstream.ok) {
        return json(res, 502, { ok: false, error: `moltbook.com returned ${upstream.status}` });
      }
      const data = await upstream.json();
      return json(res, 200, { ok: true, posts: data });
    } catch (err) {
      return json(res, 502, { ok: false, error: `Could not reach moltbook.com: ${String(err)}` });
    }
  }

  // ── REST API: Clawhub marketplace proxy (clawhub.ai) ────────
  if (url.startsWith("/api/clawhub/browse") && method === "GET") {
    try {
      const reqUrl = new URL(req.url ?? "/", "http://localhost");
      const sort = reqUrl.searchParams.get("sort") || "trending";
      const query = reqUrl.searchParams.get("q") || "";
      const limit = reqUrl.searchParams.get("limit") || "50";

      let upstream: string;
      if (query) {
        upstream = `https://clawhub.ai/api/v1/search?q=${encodeURIComponent(query)}&limit=${limit}`;
      } else {
        upstream = `https://clawhub.ai/api/v1/skills?sort=${encodeURIComponent(sort)}&limit=${limit}`;
      }

      const response = await fetch(upstream, {
        headers: { "Accept": "application/json" },
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) {
        return json(res, 502, { ok: false, error: `clawhub.ai returned ${response.status}` });
      }
      const data = await response.json();
      return json(res, 200, { ok: true, data });
    } catch (err) {
      return json(res, 502, { ok: false, error: `Could not reach clawhub.ai: ${String(err)}` });
    }
  }

  // ── REST API: Generate 3D object via LLM ───────────────────
  if (url === "/api/generate-object" && method === "POST") {
    if (!OPENROUTER_API_KEY) {
      return json(res, 503, { ok: false, error: "OPENROUTER_API_KEY not configured" });
    }
    try {
      const body = (await readBody(req)) as { prompt?: string };
      if (!body?.prompt || typeof body.prompt !== "string") {
        return json(res, 400, { ok: false, error: "prompt required" });
      }

      const key = body.prompt.toLowerCase().trim();

      // Two-tier cache: persisted registry first, then in-memory
      const registryHit = objectRegistry.findByName(body.prompt);
      if (registryHit?.code) {
        return json(res, 200, { ok: true, name: registryHit.name, code: registryHit.code });
      }
      const cached = objectCache.get(key);
      if (cached) {
        return json(res, 200, { ok: true, name: cached.name, code: cached.code });
      }

      const codeSystemPrompt = `You are a Three.js code generator. Generate ONLY a JavaScript function body that creates a 3D representation of a given object.

Requirements:
- The code receives THREE as a parameter (do NOT import it)
- Create a THREE.Group, add meshes to it, and return the group
- Use THREE.MeshStandardMaterial with appropriate colors
- The entire object should fit within a 2x2x2 bounding box centered at origin
- Make it visually recognizable for what it represents
- Use basic geometries: BoxGeometry, SphereGeometry, CylinderGeometry, ConeGeometry, TorusGeometry, IcosahedronGeometry, etc.
- You can combine multiple geometries for more complex shapes
- NO comments, NO console.log, NO markdown formatting, NO function declaration wrapper
- Return ONLY the raw JavaScript code starting with "const group = new THREE.Group();" and ending with "return group;"`;

      let code = await callOpenRouter(codeSystemPrompt, `Create a 3D mesh for: ${body.prompt}`);
      code = stripCodeFences(code);

      // Validate: must parse as a function body
      try {
        new Function("THREE", code);
      } catch (parseErr) {
        console.warn("[generate-object] Code failed to parse, retrying with simpler prompt…");
        console.warn("[generate-object] Bad code was:", code.slice(0, 300));
        code = await callOpenRouter(
          codeSystemPrompt,
          `Create a very simple 3D mesh for: ${body.prompt}. Use only ONE geometry and ONE material. Keep it as simple as possible.`,
        );
        code = stripCodeFences(code);

        try {
          new Function("THREE", code);
        } catch {
          // Ultimate fallback — blue sphere
          code = [
            'const group = new THREE.Group();',
            'const geo = new THREE.SphereGeometry(0.5, 16, 16);',
            'const mat = new THREE.MeshStandardMaterial({ color: 0x88aacc });',
            'group.add(new THREE.Mesh(geo, mat));',
            'return group;',
          ].join("\n");
        }
      }

      objectCache.set(key, body.prompt, code);
      // Persist code to registry if object type exists
      if (registryHit) {
        objectRegistry.setCode(registryHit.objectTypeId, code);
      }
      return json(res, 200, { ok: true, name: body.prompt, code });
    } catch (err) {
      console.error("[generate-object] Error:", err);
      return json(res, 500, { ok: false, error: String(err) });
    }
  }

  // ── REST API: Clawhub (local plugins) ──────────────────────
  if (url === "/api/clawhub/skills" && method === "GET") {
    return json(res, 200, { ok: true, skills: clawhub.list() });
  }

  if (url === "/api/clawhub/skills" && method === "POST") {
    try {
      const body = (await readBody(req)) as {
        id?: string; name?: string; description?: string;
        author?: string; version?: string; tags?: string[];
      };
      if (!body.id || !body.name) {
        return json(res, 400, { ok: false, error: "id and name required" });
      }
      const skill = clawhub.publish({
        id: body.id,
        name: body.name,
        description: body.description ?? "",
        author: body.author ?? "unknown",
        version: body.version ?? "0.1.0",
        tags: body.tags ?? [],
      });
      return json(res, 201, { ok: true, skill });
    } catch (err) {
      return json(res, 400, { ok: false, error: String(err) });
    }
  }

  if (url === "/api/clawhub/install" && method === "POST") {
    try {
      const body = (await readBody(req)) as { skillId?: string };
      if (!body.skillId) {
        return json(res, 400, { ok: false, error: "skillId required" });
      }
      const record = clawhub.install(body.skillId);
      if (!record) return json(res, 404, { ok: false, error: "skill not found" });
      return json(res, 200, { ok: true, installed: record });
    } catch (err) {
      return json(res, 400, { ok: false, error: String(err) });
    }
  }

  if (url === "/api/clawhub/uninstall" && method === "POST") {
    try {
      const body = (await readBody(req)) as { skillId?: string };
      if (!body.skillId) {
        return json(res, 400, { ok: false, error: "skillId required" });
      }
      const ok = clawhub.uninstall(body.skillId);
      return json(res, ok ? 200 : 404, { ok });
    } catch (err) {
      return json(res, 400, { ok: false, error: String(err) });
    }
  }

  if (url === "/api/clawhub/installed" && method === "GET") {
    return json(res, 200, { ok: true, installed: clawhub.getInstalled() });
  }

  // ── REST API: Event logs (local JSONL files) ─────────────────
  const LOG_DIR = resolve(import.meta.dirname, "..", "logs");

  if (url === "/api/logs" && method === "GET") {
    try {
      if (!existsSync(LOG_DIR)) return json(res, 200, { ok: true, files: [] });
      const files = readdirSync(LOG_DIR)
        .filter((f) => f.endsWith(".jsonl"))
        .sort()
        .reverse();
      return json(res, 200, { ok: true, files });
    } catch (err) {
      return json(res, 500, { ok: false, error: String(err) });
    }
  }

  if (url.startsWith("/api/logs/") && method === "GET") {
    try {
      const filename = url.slice("/api/logs/".length).split("?")[0];
      if (!filename.match(/^events-\d{4}-\d{2}-\d{2}\.jsonl$/)) {
        return json(res, 400, { ok: false, error: "Invalid filename" });
      }
      const filepath = join(LOG_DIR, filename);
      if (!existsSync(filepath)) return json(res, 404, { ok: false, error: "File not found" });

      const reqUrl = new URL(req.url ?? "/", "http://localhost");
      const typeFilter = reqUrl.searchParams.get("type");
      const agentFilter = reqUrl.searchParams.get("agent");
      const searchFilter = reqUrl.searchParams.get("q");

      const raw = readFileSync(filepath, "utf-8");
      let events = raw
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => { try { return JSON.parse(line); } catch { return null; } })
        .filter(Boolean);

      if (typeFilter) events = events.filter((e: { type?: string }) => e.type === typeFilter);
      if (agentFilter) events = events.filter((e: { agentId?: string }) => e.agentId === agentFilter);
      if (searchFilter) {
        const q = searchFilter.toLowerCase();
        events = events.filter((e: Record<string, unknown>) => JSON.stringify(e).toLowerCase().includes(q));
      }

      return json(res, 200, { ok: true, count: events.length, events });
    } catch (err) {
      return json(res, 500, { ok: false, error: String(err) });
    }
  }

  // ── Admin API ──────────────────────────────────────────────
  if (url === "/api/admin/login" && method === "POST") {
    try {
      const adminPassword = process.env.ADMIN_PASSWORD;
      if (!adminPassword) {
        return json(res, 403, { ok: false, error: "Admin console not configured" });
      }
      const body = (await readBody(req)) as { password?: string };
      if (!body?.password || body.password !== adminPassword) {
        return json(res, 401, { ok: false, error: "Invalid password" });
      }
      const token = createAdminSession();
      return json(res, 200, { ok: true, token });
    } catch (err) {
      return json(res, 400, { ok: false, error: String(err) });
    }
  }

  if (url === "/api/admin/status" && method === "GET") {
    if (!requireAdmin(req)) {
      return json(res, 401, { ok: false, error: "Unauthorized" });
    }
    return json(res, 200, { ok: true });
  }

  if (url === "/api/admin/broadcast" && method === "POST") {
    if (!requireAdmin(req)) {
      return json(res, 401, { ok: false, error: "Unauthorized" });
    }
    try {
      const body = (await readBody(req)) as { text?: string };
      const text = body?.text?.trim();
      if (!text) return json(res, 400, { ok: false, error: "text required" });
      currentAnnouncement = text.slice(0, 500);
      announcementTs = Date.now();
      agentAnnouncementState.clear();
      return json(res, 200, { ok: true });
    } catch (err) {
      return json(res, 400, { ok: false, error: String(err) });
    }
  }

  if (url === "/api/admin/rally" && method === "POST") {
    if (!requireAdmin(req)) {
      return json(res, 401, { ok: false, error: "Unauthorized" });
    }
    try {
      const body = (await readBody(req)) as { x?: number; z?: number };
      const x = Number(body?.x ?? 0);
      const z = Number(body?.z ?? 0);
      const activeIds = state.getActiveAgentIds();
      let moved = 0;
      for (const agentId of activeIds) {
        const msg: PositionMessage = {
          worldType: "position",
          agentId,
          x, y: 0, z,
          rotation: 0,
          timestamp: Date.now(),
        };
        commandQueue.enqueue(msg);
        moved++;
      }
      currentAnnouncement = `All agents have been rallied to (${x}, ${z})`;
      announcementTs = Date.now();
      agentAnnouncementState.clear();
      return json(res, 200, { ok: true, moved });
    } catch (err) {
      return json(res, 400, { ok: false, error: String(err) });
    }
  }

  // ── IPC JSON API (agent commands — go through command queue) ─
  if (method === "POST" && (url === "/" || url === "/ipc")) {
    try {
      const parsed = (await readBody(req)) as Record<string, unknown>;
      const result = await handleCommand(parsed);
      const response = result as Record<string, unknown>;

      // Inject announcement into IPC responses (skip dismiss-announcement itself)
      const agentId = (parsed.args as Record<string, unknown> | undefined)?.agentId as string | undefined;
      const command = parsed.command as string | undefined;
      if (agentId && currentAnnouncement && command !== "dismiss-announcement") {
        const agentState = agentAnnouncementState.get(agentId);
        if (!agentState) {
          // First time this agent sees the announcement
          response.announcement = `NEW ANNOUNCEMENT: ${currentAnnouncement}`;
          agentAnnouncementState.set(agentId, { seenAt: Date.now(), callCount: 0 });
        } else {
          agentState.callCount++;
          if (agentState.callCount % 3 === 0) {
            response.announcement = `Remember the announcement: ${currentAnnouncement}. If you have accomplished the goal outlined in the announcement, you can run dismiss-announcement.`;
          }
        }
      }

      return json(res, 200, response);
    } catch (err) {
      return json(res, 400, { error: String(err) });
    }
  }

  // ── Server info ─────────────────────────────────────────────
  if (method === "GET" && url === "/health") {
    return json(res, 200, {
      status: "ok",
      roomId: config.roomId,
      agents: registry.getOnline().length,
      clients: clientManager.size,
      tick: gameLoop.currentTick,
      tickRate: TICK_RATE,
    });
  }

  // ── Static file serving (production: serve built frontend) ────
  const DIST_DIR = resolve(import.meta.dirname, "..", "dist");
  if (method === "GET" && existsSync(DIST_DIR)) {
    const MIME: Record<string, string> = {
      ".html": "text/html", ".js": "application/javascript", ".css": "text/css",
      ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg",
      ".svg": "image/svg+xml", ".ico": "image/x-icon", ".woff2": "font/woff2",
      ".woff": "font/woff", ".ttf": "font/ttf", ".map": "application/json",
    };

    // Map clean paths to files
    let filePath: string;
    if (url === "/" || url === "/index.html") {
      filePath = join(DIST_DIR, "index.html");
    } else if (url === "/logs" || url === "/logs.html") {
      filePath = join(DIST_DIR, "logs.html");
    } else if (url === "/admin" || url === "/admin.html") {
      filePath = join(DIST_DIR, "admin.html");
    } else {
      filePath = join(DIST_DIR, url.split("?")[0]);
    }

    // Prevent path traversal
    if (filePath.startsWith(DIST_DIR) && existsSync(filePath)) {
      try {
        const stat = statSync(filePath);
        if (stat.isFile()) {
          const ext = extname(filePath);
          const contentType = MIME[ext] ?? "application/octet-stream";
          const body = readFileSync(filePath);
          res.writeHead(200, {
            "Content-Type": contentType,
            "Content-Length": body.byteLength,
            "Access-Control-Allow-Origin": "*",
          });
          res.end(body);
          return;
        }
      } catch { /* fall through to 404 */ }
    }
  }

  json(res, 404, { error: "Not found" });
});

// ── WebSocket bridge ───────────────────────────────────────────

new WSBridge(server, clientManager, {
  getProfiles: () => {
    // Only return profiles of agents currently in the world (with positions)
    const activeIds = state.getActiveAgentIds();
    return registry.getAll().filter((p) => activeIds.has(p.agentId));
  },
  getProfile: (id) => registry.get(id),
  getRoomInfo,
});

// ── Nostr integration (for room sharing via relay) ─────────────

nostr.setAgentValidator((agentId: string) => registry.get(agentId) !== undefined);
nostr.setMessageHandler((msg: WorldMessage) => {
  commandQueue.enqueue(msg);
});

// ── IPC command handler ────────────────────────────────────────

async function handleCommand(parsed: Record<string, unknown>): Promise<unknown> {
  const { command, args } = parsed as {
    command: string;
    args?: Record<string, unknown>;
  };

  // Commands that require a registered agentId
  const agentCommands = new Set([
    "world-move", "world-action", "world-chat", "world-emote", "world-leave",
    "world-spawn", "world-pickup", "world-drop", "world-craft", "world-inventory",
    "dismiss-announcement",
    "look-around",
  ]);
  if (agentCommands.has(command)) {
    const agentId = (args as { agentId?: string })?.agentId;
    if (!agentId || !registry.get(agentId)) {
      throw new Error("Unknown or unregistered agentId");
    }
  }

  switch (command) {
    case "register": {
      const roomToken = process.env.ROOM_TOKEN;
      if (roomToken) {
        const provided = (args as { token?: string })?.token;
        if (provided !== roomToken) {
          return { ok: false, error: "invalid token" };
        }
      }

      const onlineCount = state.getActiveAgentIds().size;
      if (onlineCount >= config.maxAgents) {
        return { ok: false, error: `Room is full (${config.maxAgents} max)` };
      }

      const a = args as {
        agentId: string;
        name?: string;
        pubkey?: string;
        bio?: string;
        capabilities?: string[];
        color?: string;
        skills?: AgentSkillDeclaration[];
        token?: string;
      };
      if (!a?.agentId) throw new Error("agentId required");
      const profile = registry.register(a);

      const joinMsg: JoinMessage = {
        worldType: "join",
        agentId: profile.agentId,
        name: profile.name,
        color: profile.color,
        bio: profile.bio,
        capabilities: profile.capabilities,
        skills: profile.skills,
        timestamp: Date.now(),
      };
      commandQueue.enqueue(joinMsg);

      // Assign starting objects if agent has no knowledge yet
      if (itemState.getKnowledge(profile.agentId).length === 0) {
        const baseIds = objectRegistry.getBaseObjectIds();
        const onlineIds = state.getActiveAgentIds();
        const assigned = itemState.getAssignedBaseObjects(onlineIds);

        // Pick 2 unassigned base objects, or random if all assigned
        const unassigned = baseIds.filter((id) => !assigned.has(id));
        const pool = unassigned.length >= 2 ? unassigned : baseIds;

        // Shuffle and pick 2
        const shuffled = [...pool].sort(() => Math.random() - 0.5);
        itemState.initKnowledge(profile.agentId, shuffled.slice(0, 2));
      }

      const baseUrl = `http://${config.host === "0.0.0.0" ? "127.0.0.1" : config.host}:${config.port}`;
      const previewUrl = `${baseUrl}/?agent=${encodeURIComponent(profile.agentId)}`;
      return {
        ok: true,
        profile,
        knownObjects: itemState.getKnowledge(profile.agentId),
        previewUrl,
        ipcUrl: `${baseUrl}/ipc`,
      };
    }

    case "profiles":
      return { ok: true, profiles: registry.getAll() };

    case "profile": {
      const agentId = (args as { agentId?: string })?.agentId;
      if (!agentId) throw new Error("agentId required");
      const profile = registry.get(agentId);
      return profile ? { ok: true, profile } : { ok: false, error: "not found" };
    }

    case "world-move": {
      const a = args as { agentId: string; x: number; y: number; z: number; rotation?: number };
      if (!a?.agentId) throw new Error("agentId required");
      const x = Number(a.x ?? 0);
      const y = Number(a.y ?? 0);
      const z = Number(a.z ?? 0);
      const rotation = Number(a.rotation ?? 0);
      if (!isFinite(x) || !isFinite(y) || !isFinite(z) || !isFinite(rotation)) {
        throw new Error("x, y, z, rotation must be finite numbers");
      }
      const msg: WorldMessage = {
        worldType: "position",
        agentId: a.agentId,
        x,
        y,
        z,
        rotation,
        timestamp: Date.now(),
      };
      const result = commandQueue.enqueue(msg);
      if (!result.ok) return { ok: false, error: result.reason };
      return { ok: true };
    }

    case "world-action": {
      const a = args as { agentId: string; action: string; targetAgentId?: string };
      if (!a?.agentId) throw new Error("agentId required");
      const msg: WorldMessage = {
        worldType: "action",
        agentId: a.agentId,
        action: (a.action ?? "idle") as "walk" | "idle" | "wave" | "pinch" | "talk" | "dance" | "backflip" | "spin",
        targetAgentId: a.targetAgentId,
        timestamp: Date.now(),
      };
      commandQueue.enqueue(msg);
      return { ok: true };
    }

    case "world-chat": {
      const a = args as { agentId: string; text: string };
      if (!a?.agentId || !a?.text) throw new Error("agentId and text required");
      const msg: WorldMessage = {
        worldType: "chat",
        agentId: a.agentId,
        text: a.text.slice(0, 500),
        timestamp: Date.now(),
      };
      commandQueue.enqueue(msg);
      return { ok: true };
    }

    case "world-emote": {
      const a = args as { agentId: string; emote: string };
      if (!a?.agentId) throw new Error("agentId required");
      const msg: WorldMessage = {
        worldType: "emote",
        agentId: a.agentId,
        emote: (a.emote ?? "happy") as "happy" | "thinking" | "surprised" | "laugh",
        timestamp: Date.now(),
      };
      commandQueue.enqueue(msg);
      return { ok: true };
    }

    case "world-leave": {
      const a = args as { agentId: string };
      if (!a?.agentId) throw new Error("agentId required");

      // Drop all held items at agent's last position
      const leavePos = state.getPosition(a.agentId);
      if (leavePos) {
        const dropped = itemState.dropAllItems(a.agentId, leavePos.x, leavePos.z);
        for (const item of dropped) {
          const dropMsg: ItemDropMessage = {
            worldType: "item-drop",
            agentId: a.agentId,
            itemId: item.itemId,
            x: item.x,
            z: item.z,
            timestamp: Date.now(),
          };
          commandQueue.enqueue(dropMsg);
        }
      }

      const msg: WorldMessage = {
        worldType: "leave",
        agentId: a.agentId,
        timestamp: Date.now(),
      };
      commandQueue.enqueue(msg);
      return { ok: true };
    }

    // ── Clawhub IPC commands ──────────────────────────────────
    case "clawhub-list":
      return { ok: true, skills: clawhub.list() };

    case "clawhub-publish": {
      const a = args as {
        id?: string; name?: string; description?: string;
        author?: string; version?: string; tags?: string[];
      };
      if (!a?.id || !a?.name) throw new Error("id and name required");
      const skill = clawhub.publish({
        id: a.id,
        name: a.name,
        description: a.description ?? "",
        author: a.author ?? "unknown",
        version: a.version ?? "0.1.0",
        tags: a.tags ?? [],
      });
      return { ok: true, skill };
    }

    case "clawhub-install": {
      const a = args as { skillId?: string };
      if (!a?.skillId) throw new Error("skillId required");
      const record = clawhub.install(a.skillId);
      if (!record) throw new Error("skill not found");
      return { ok: true, installed: record };
    }

    case "clawhub-uninstall": {
      const a = args as { skillId?: string };
      if (!a?.skillId) throw new Error("skillId required");
      const ok = clawhub.uninstall(a.skillId);
      return { ok };
    }

    // ── Room management IPC commands ────────────────────────
    case "room-info":
      return { ok: true, ...getRoomInfo() };

    case "room-events": {
      const a = args as { since?: number; limit?: number };
      const since = Number(a?.since ?? 0);
      const limit = Math.min(Number(a?.limit ?? 50), 200);
      return { ok: true, events: state.getEvents(since, limit) };
    }

    case "room-invite": {
      const info = getRoomInfo();
      return {
        ok: true,
        invite: {
          roomId: info.roomId,
          name: info.name,
          relays: nostr.getRelays(),
          channelId: nostr.getChannelId(),
          agents: info.agents,
          maxAgents: info.maxAgents,
        },
      };
    }

    case "room-skills": {
      const allProfiles = registry.getAll();
      const directory: Record<string, { agentId: string; agentName: string; skill: AgentSkillDeclaration }[]> = {};
      for (const p of allProfiles) {
        for (const skill of p.skills ?? []) {
          if (!directory[skill.skillId]) directory[skill.skillId] = [];
          directory[skill.skillId].push({ agentId: p.agentId, agentName: p.name, skill });
        }
      }
      return { ok: true, directory };
    }

    // ── Crafting IPC commands ──────────────────────────────────

    case "world-spawn": {
      const a = args as { agentId: string; objectTypeId: string };
      if (!a?.agentId || !a?.objectTypeId) throw new Error("agentId and objectTypeId required");
      if (!itemState.hasKnowledge(a.agentId, a.objectTypeId)) {
        return { ok: false, error: "You don't know how to create that object", knownObjects: itemState.getKnowledge(a.agentId) };
      }
      const objType = objectRegistry.get(a.objectTypeId);
      if (!objType) return { ok: false, error: "Unknown object type" };

      const pos = state.getPosition(a.agentId);
      if (!pos) return { ok: false, error: "Agent not in world" };

      const itemId = `item_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const x = pos.x + (Math.random() - 0.5) * 2;
      const z = pos.z + (Math.random() - 0.5) * 2;

      itemState.spawnItem(itemId, a.objectTypeId, x, z);

      const msg: ItemSpawnMessage = {
        worldType: "item-spawn",
        agentId: a.agentId,
        itemId,
        objectTypeId: a.objectTypeId,
        name: objType.name,
        color: objType.color,
        x,
        z,
        timestamp: Date.now(),
      };
      commandQueue.enqueue(msg);
      return { ok: true, itemId, name: objType.name, x, z };
    }

    case "world-pickup": {
      const a = args as { agentId: string; itemId: string };
      if (!a?.agentId || !a?.itemId) throw new Error("agentId and itemId required");

      const item = itemState.getItem(a.itemId);
      if (!item) return { ok: false, error: "Item not found" };
      if (item.heldBy) return { ok: false, error: "Item is already held by another agent" };

      const pos = state.getPosition(a.agentId);
      if (!pos) return { ok: false, error: "Agent not in world" };

      // Check proximity
      const dx = pos.x - item.x;
      const dz = pos.z - item.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist > ITEM_PICKUP_RADIUS) {
        return { ok: false, error: "Too far from item", walkTo: { x: item.x, z: item.z }, distance: dist };
      }

      const result = itemState.pickupItem(a.agentId, a.itemId);
      if (!result.ok) return result;

      const objType = objectRegistry.get(item.objectTypeId);
      const msg: ItemPickupMessage = {
        worldType: "item-pickup",
        agentId: a.agentId,
        itemId: a.itemId,
        slot: result.slot!,
        timestamp: Date.now(),
      };
      commandQueue.enqueue(msg);
      return { ok: true, slot: result.slot, objectTypeId: item.objectTypeId, name: objType?.name };
    }

    case "world-drop": {
      const a = args as { agentId: string; slot: number };
      if (!a?.agentId || a?.slot === undefined) throw new Error("agentId and slot required");
      const slot = a.slot as 0 | 1;
      if (slot !== 0 && slot !== 1) return { ok: false, error: "slot must be 0 or 1" };

      const pos = state.getPosition(a.agentId);
      if (!pos) return { ok: false, error: "Agent not in world" };

      const x = pos.x + (Math.random() - 0.5) * 2;
      const z = pos.z + (Math.random() - 0.5) * 2;
      const dropped = itemState.dropItem(a.agentId, slot, x, z);
      if (!dropped) return { ok: false, error: "Nothing in that slot" };

      const msg: ItemDropMessage = {
        worldType: "item-drop",
        agentId: a.agentId,
        itemId: dropped.itemId,
        x,
        z,
        timestamp: Date.now(),
      };
      commandQueue.enqueue(msg);
      return { ok: true, itemId: dropped.itemId, x, z };
    }

    case "world-craft": {
      const a = args as { agentId: string };
      if (!a?.agentId) throw new Error("agentId required");

      const inv = itemState.getInventory(a.agentId);
      if (!inv[0] || !inv[1]) {
        return { ok: false, error: "Both inventory slots must be filled to craft" };
      }

      const consumed = itemState.craftConsume(a.agentId);
      if (!consumed) return { ok: false, error: "Failed to consume inventory items" };

      const type1 = objectRegistry.get(consumed.item1.objectTypeId);
      const type2 = objectRegistry.get(consumed.item2.objectTypeId);
      if (!type1 || !type2) return { ok: false, error: "Unknown object types" };

      // Check for existing recipe
      let resultType = objectRegistry.findByRecipe(consumed.item1.objectTypeId, consumed.item2.objectTypeId);
      let isNewDiscovery = false;

      if (!resultType) {
        // Call LLM to determine result
        const existingNames = objectRegistry.getAllArray().map((t) => t.name);
        const result = await craftEngine.combine(type1.name, type2.name, existingNames);

        const objectTypeId = result.name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
        isNewDiscovery = true;

        resultType = {
          objectTypeId,
          name: result.name,
          recipe: [consumed.item1.objectTypeId, consumed.item2.objectTypeId],
          discoveredBy: a.agentId,
          discoveredAt: Date.now(),
          color: result.color,
        };
        objectRegistry.register(resultType);
      }

      // Add knowledge to the crafting agent only
      itemState.addKnowledge(a.agentId, resultType.objectTypeId);

      // Create result item at agent's feet
      const pos = state.getPosition(a.agentId);
      const x = (pos?.x ?? 0) + (Math.random() - 0.5) * 2;
      const z = (pos?.z ?? 0) + (Math.random() - 0.5) * 2;
      const resultItemId = `item_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      itemState.spawnItem(resultItemId, resultType.objectTypeId, x, z);

      // Enqueue despawn messages for consumed items
      const despawn1: ItemDespawnMessage = {
        worldType: "item-despawn",
        itemId: consumed.item1.itemId,
        timestamp: Date.now(),
      };
      const despawn2: ItemDespawnMessage = {
        worldType: "item-despawn",
        itemId: consumed.item2.itemId,
        timestamp: Date.now(),
      };
      commandQueue.enqueue(despawn1);
      commandQueue.enqueue(despawn2);

      // Enqueue craft message
      const craftMsg: ItemCraftMessage = {
        worldType: "item-craft",
        agentId: a.agentId,
        consumed: [consumed.item1.itemId, consumed.item2.itemId],
        ingredient1Name: type1.name,
        ingredient2Name: type2.name,
        resultItemId,
        resultObjectTypeId: resultType.objectTypeId,
        resultName: resultType.name,
        resultColor: resultType.color,
        isNewDiscovery,
        x,
        z,
        timestamp: Date.now(),
      };
      commandQueue.enqueue(craftMsg);

      return {
        ok: true,
        result: resultType,
        resultItemId,
        isNewDiscovery,
        x,
        z,
        knownObjects: itemState.getKnowledge(a.agentId),
      };
    }

    case "world-inventory": {
      const a = args as { agentId: string };
      if (!a?.agentId) throw new Error("agentId required");
      const inv = itemState.getInventory(a.agentId);
      const slots = inv.map((itemId) => {
        if (!itemId) return null;
        const item = itemState.getItem(itemId);
        if (!item) return null;
        const objType = objectRegistry.get(item.objectTypeId);
        return { itemId, objectTypeId: item.objectTypeId, name: objType?.name ?? item.objectTypeId };
      });
      return {
        ok: true,
        inventory: slots,
        knownObjects: itemState.getKnowledge(a.agentId).map((id) => {
          const t = objectRegistry.get(id);
          return { objectTypeId: id, name: t?.name ?? id };
        }),
      };
    }

    case "look-around": {
      const a = args as { agentId: string };
      const myPos = state.getPosition(a.agentId);
      const myX = myPos?.x ?? 0;
      const myZ = myPos?.z ?? 0;

      // Build agent list (exclude calling agent)
      const agents: { agentId: string; name: string; x: number; z: number }[] = [];
      for (const [id, pos] of state.getAllPositions()) {
        if (id === a.agentId) continue;
        const profile = registry.get(id);
        agents.push({ agentId: id, name: profile?.name ?? id, x: pos.x, z: pos.z });
      }

      // Build grouped items list
      const groundItems = itemState.getGroundItems();
      const groups = new Map<string, { name: string; items: { itemId: string; x: number; z: number; dist: number }[] }>();
      for (const item of groundItems) {
        let group = groups.get(item.objectTypeId);
        if (!group) {
          const objType = objectRegistry.get(item.objectTypeId);
          group = { name: objType?.name ?? item.objectTypeId, items: [] };
          groups.set(item.objectTypeId, group);
        }
        const dx = item.x - myX;
        const dz = item.z - myZ;
        group.items.push({ itemId: item.itemId, x: item.x, z: item.z, dist: dx * dx + dz * dz });
      }

      const items: { objectTypeId: string; name: string; quantity: number; nearest: { itemId: string; x: number; z: number } }[] = [];
      for (const [objectTypeId, group] of groups) {
        group.items.sort((a, b) => a.dist - b.dist);
        const near = group.items[0];
        items.push({
          objectTypeId,
          name: group.name,
          quantity: group.items.length,
          nearest: { itemId: near.itemId, x: near.x, z: near.z },
        });
      }

      return { ok: true, agents, items };
    }

    case "world-discoveries": {
      return { ok: true, objectTypes: objectRegistry.getAll() };
    }

    case "dismiss-announcement": {
      const a = args as { agentId: string };
      agentAnnouncementState.delete(a.agentId);
      return { ok: true };
    }

    case "describe": {
      const skillPath = resolve(import.meta.dirname, "../skills/world-room/skill.json");
      const schema = JSON.parse(readFileSync(skillPath, "utf-8"));
      return { ok: true, skill: schema };
    }

    case "open-preview": {
      const a = args as { agentId?: string };
      const vitePort = process.env.VITE_PORT ?? "3000";
      const serverUrl = `http://127.0.0.1:${config.port}`;
      const url = a?.agentId
        ? `http://localhost:${vitePort}/?agent=${encodeURIComponent(a.agentId)}&server=${encodeURIComponent(serverUrl)}`
        : `http://localhost:${vitePort}/?server=${encodeURIComponent(serverUrl)}`;

      const { execFile } = await import("node:child_process");
      const cmd = process.platform === "darwin" ? "open"
        : process.platform === "win32" ? "start"
        : "xdg-open";
      execFile(cmd, [url], (err) => {
        if (err) console.warn("[server] Failed to open browser:", err.message);
      });

      return { ok: true, url };
    }

    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

// ── Startup ────────────────────────────────────────────────────

async function main() {
  console.log("🦞 OpenClaw Ocean World starting...");
  console.log(`[room] Room ID: ${config.roomId} | Name: "${config.roomName}"`);
  if (config.roomDescription) {
    console.log(`[room] Description: ${config.roomDescription}`);
  }
  console.log(`[room] Max agents: ${config.maxAgents} | Bind: ${config.host}:${config.port}`);
  console.log(`[engine] Tick rate: ${TICK_RATE}Hz | AOI radius: 40 units`);

  await nostr.init().catch((err) => {
    console.warn("[nostr] Init warning:", err.message ?? err);
    console.warn("[nostr] Running in local-only mode (no relay connection)");
  });

  server.listen(config.port, config.host, () => {
    console.log(`[server] IPC + WS listening on http://${config.host}:${config.port}`);
    console.log(`[server] Share Room ID "${config.roomId}" for others to join via Nostr`);
  });

  gameLoop.start();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

process.on("SIGINT", () => {
  console.log("\nShutting down...");
  gameLoop.stop();
  nostr.close();
  server.close();
  process.exit(0);
});
