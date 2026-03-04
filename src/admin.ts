import { WSClient } from "./net/ws-client";

// ── Types ────────────────────────────────────────────────────

interface LogEvent {
  tick: number;
  ts: string;
  type: string;
  agentId: string;
  data: Record<string, unknown>;
}

interface AgentProfile {
  agentId: string;
  name: string;
  color: string;
  bio: string;
}

interface AgentState {
  profile: AgentProfile;
  position: { x: number; y: number; z: number };
  action: string;
}

interface WorldMessage {
  worldType: string;
  agentId: string;
  [key: string]: unknown;
}

// ── DOM refs ─────────────────────────────────────────────────

const loginScreen = document.getElementById("login-screen")!;
const adminPanel = document.getElementById("admin-panel")!;
const loginForm = document.getElementById("login-form") as HTMLFormElement;
const passwordInput = document.getElementById(
  "password-input"
) as HTMLInputElement;
const loginError = document.getElementById("login-error")!;
const logoutBtn = document.getElementById("logout-btn")!;

const feedTypeFilter = document.getElementById(
  "feed-type-filter"
) as HTMLSelectElement;
const eventList = document.getElementById("event-list")!;
const minimapCanvas = document.getElementById("minimap") as HTMLCanvasElement;
const agentListEl = document.getElementById("agent-list")!;
const broadcastInput = document.getElementById(
  "broadcast-input"
) as HTMLInputElement;
const broadcastSendBtn = document.getElementById("broadcast-send-btn")!;
const rallyBtn = document.getElementById("rally-btn")!;
const connectionStatus = document.getElementById("connection-status")!;
const agentCountEl = document.getElementById("agent-count")!;

// ── State ────────────────────────────────────────────────────

const API_BASE = "";
let ws: WSClient | null = null;
let agents: Map<string, AgentState> = new Map();
let allEvents: LogEvent[] = [];
let liveInterval: ReturnType<typeof setInterval> | null = null;

// ── Auth helpers ─────────────────────────────────────────────

function getToken(): string | null {
  return sessionStorage.getItem("adminToken");
}

function setToken(token: string): void {
  sessionStorage.setItem("adminToken", token);
}

function clearToken(): void {
  sessionStorage.removeItem("adminToken");
}

function showAdmin(): void {
  loginScreen.classList.add("hidden");
  adminPanel.classList.remove("hidden");
  initDashboard();
}

function showLogin(): void {
  adminPanel.classList.add("hidden");
  loginScreen.classList.remove("hidden");
  loginError.classList.add("hidden");
  passwordInput.value = "";
  teardownDashboard();
}

async function validateSession(): Promise<boolean> {
  const token = getToken();
  if (!token) return false;
  try {
    const res = await fetch(`${API_BASE}/api/admin/status`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    return data.ok === true;
  } catch {
    return false;
  }
}

async function login(password: string): Promise<void> {
  loginError.classList.add("hidden");
  try {
    const res = await fetch(`${API_BASE}/api/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    const data = await res.json();
    if (data.ok && data.token) {
      setToken(data.token);
      showAdmin();
    } else {
      loginError.textContent = data.error || "Invalid password";
      loginError.classList.remove("hidden");
    }
  } catch {
    loginError.textContent = "Could not reach server";
    loginError.classList.remove("hidden");
  }
}

// ── Helpers ──────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatTime(ts: string): string {
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return ts;
  }
}

function getEventSummary(ev: LogEvent): string {
  const d = ev.data;
  switch (ev.type) {
    case "chat":
      return `<span class="chat-text">"${escapeHtml(String(d.text ?? ""))}"</span>`;
    case "join": {
      const name = d.name ?? ev.agentId;
      const color = d.color ?? "";
      return (
        `<b>${escapeHtml(String(name))}</b> joined` +
        (color ? ` <span style="color:${escapeHtml(String(color))}">●</span>` : "")
      );
    }
    case "leave":
      return "left the room";
    case "position":
      return `moved to (${Number(d.x).toFixed(1)}, ${Number(d.z).toFixed(1)})`;
    case "action":
      return `performed <b>${escapeHtml(String(d.action ?? "?"))}</b>`;
    case "emote":
      return `emoted <b>${escapeHtml(String(d.emote ?? "?"))}</b>`;
    case "profile":
      return `updated profile → ${escapeHtml(String(d.name ?? ""))}`;
    default:
      return escapeHtml(JSON.stringify(d).slice(0, 100));
  }
}

function showToast(message: string): void {
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 2200);
}

// ── Dashboard init / teardown ────────────────────────────────

function initDashboard(): void {
  connectWebSocket();
  loadActivityFeed();
  startLivePolling();
}

function teardownDashboard(): void {
  stopLivePolling();
  agents.clear();
  allEvents = [];
}

// ── WebSocket ────────────────────────────────────────────────

function connectWebSocket(): void {
  ws = new WSClient();

  ws.on("connected", () => {
    updateConnectionStatus(true);
    ws!.requestProfiles();
    // Send a large viewport to get all agents in snapshots
    ws!.reportViewport(0, 0);
  });

  ws.on("disconnected", () => {
    updateConnectionStatus(false);
  });

  ws.on("snapshot", (data: unknown) => {
    const msg = data as { type: string; agents: AgentState[] };
    agents.clear();
    for (const a of msg.agents) {
      agents.set(a.profile.agentId, a);
    }
    updateAgentList();
    updateAgentCount();
    drawMinimap();
  });

  ws.on("profiles", (data: unknown) => {
    const msg = data as { type: string; profiles: AgentProfile[] };
    for (const p of msg.profiles) {
      const existing = agents.get(p.agentId);
      if (existing) {
        existing.profile = p;
      } else {
        agents.set(p.agentId, {
          profile: p,
          position: { x: 0, y: 0, z: 0 },
          action: "idle",
        });
      }
    }
    updateAgentList();
    drawMinimap();
  });

  ws.on("profile", (data: unknown) => {
    const msg = data as { type: string; profile: AgentProfile };
    const existing = agents.get(msg.profile.agentId);
    if (existing) {
      existing.profile = msg.profile;
    } else {
      agents.set(msg.profile.agentId, {
        profile: msg.profile,
        position: { x: 0, y: 0, z: 0 },
        action: "idle",
      });
    }
    updateAgentList();
  });

  ws.on("world", (data: unknown) => {
    const msg = data as { type: string; message: WorldMessage };
    const wm = msg.message;
    handleWorldEvent(wm);
  });

  ws.connect();
}

function handleWorldEvent(wm: WorldMessage): void {
  const agentId = wm.agentId;

  switch (wm.worldType) {
    case "join": {
      agents.set(agentId, {
        profile: {
          agentId,
          name: String(wm.name ?? agentId),
          color: String(wm.color ?? "#888"),
          bio: String(wm.bio ?? ""),
        },
        position: { x: 0, y: 0, z: 0 },
        action: "idle",
      });
      updateAgentList();
      updateAgentCount();
      drawMinimap();
      break;
    }
    case "leave": {
      agents.delete(agentId);
      updateAgentList();
      updateAgentCount();
      drawMinimap();
      break;
    }
    case "position": {
      const a = agents.get(agentId);
      if (a) {
        a.position = {
          x: Number(wm.x ?? 0),
          y: Number(wm.y ?? 0),
          z: Number(wm.z ?? 0),
        };
      }
      drawMinimap();
      break;
    }
    case "action": {
      const a = agents.get(agentId);
      if (a) {
        a.action = String(wm.action ?? "idle");
      }
      updateAgentList();
      break;
    }
    case "profile": {
      const a = agents.get(agentId);
      if (a) {
        a.profile.name = String(wm.name ?? a.profile.name);
        a.profile.color = String(wm.color ?? a.profile.color);
        a.profile.bio = String(wm.bio ?? a.profile.bio);
      }
      updateAgentList();
      drawMinimap();
      break;
    }
  }
}

function updateConnectionStatus(connected: boolean): void {
  const dot = connectionStatus.querySelector(".status-dot")!;
  if (connected) {
    dot.className = "status-dot connected";
    connectionStatus.innerHTML = '<span class="status-dot connected"></span> Connected';
  } else {
    dot.className = "status-dot disconnected";
    connectionStatus.innerHTML = '<span class="status-dot disconnected"></span> Disconnected';
  }
}

function updateAgentCount(): void {
  const count = agents.size;
  agentCountEl.textContent = `${count} agent${count !== 1 ? "s" : ""}`;
}

// ── Activity Feed ────────────────────────────────────────────

async function loadActivityFeed(): Promise<void> {
  try {
    const res = await fetch(`${API_BASE}/api/logs`);
    const data = await res.json();
    const files: string[] = data.files ?? [];
    if (files.length === 0) {
      eventList.innerHTML = '<div class="feed-empty">No events yet</div>';
      return;
    }
    // Load the most recent (first) file
    await loadFeedEvents(files[0]);
  } catch (err) {
    console.error("[feed] loadActivityFeed failed:", err);
    eventList.innerHTML = '<div class="feed-empty">Failed to load events</div>';
  }
}

async function loadFeedEvents(filename: string): Promise<void> {
  try {
    const res = await fetch(`${API_BASE}/api/logs/${filename}`);
    const data = await res.json();
    allEvents = data.events ?? [];
    renderFeed();
  } catch (err) {
    console.error("[feed] loadFeedEvents failed:", err);
    renderFeed();
  }
}

function renderFeed(): void {
  const filter = feedTypeFilter.value;
  let events = allEvents;
  if (filter) events = events.filter((e) => e.type === filter);

  // newest first
  const reversed = [...events].reverse();

  if (reversed.length === 0) {
    eventList.innerHTML = '<div class="feed-empty">No events match filter</div>';
    return;
  }

  eventList.innerHTML = reversed
    .map(
      (ev) => `<div class="event-row">
      <span class="event-time">${formatTime(ev.ts)}</span>
      <span class="event-badge badge-${ev.type}">${ev.type}</span>
      <span class="event-agent" title="${escapeHtml(ev.agentId ?? "")}">${escapeHtml(ev.agentId ?? "")}</span>
      <span class="event-summary">${getEventSummary(ev)}</span>
    </div>`
    )
    .join("");
}

function startLivePolling(): void {
  if (liveInterval) return;
  liveInterval = setInterval(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/logs`);
      const data = await res.json();
      const files: string[] = data.files ?? [];
      if (files.length === 0) return;
      const prevCount = allEvents.length;
      await loadFeedEvents(files[0]);
      if (allEvents.length !== prevCount) {
        // auto-scroll to top (newest first)
        eventList.scrollTop = 0;
      }
    } catch (err) {
      console.error("[feed] live poll failed:", err);
    }
  }, 2000);
}

function stopLivePolling(): void {
  if (liveInterval) {
    clearInterval(liveInterval);
    liveInterval = null;
  }
}

// ── 2D Minimap ───────────────────────────────────────────────

// Hardcoded obstacle positions
const OBSTACLES = [
  { name: "Moltbook", x: -20, z: -15, radius: 3 },
  { name: "Clawhub", x: 15, z: -20, radius: 3 },
  { name: "Portal", x: 0, z: 25, radius: 2 },
];

function worldToCanvas(worldX: number, worldZ: number): [number, number] {
  // World range: -50 to 50 → Canvas: 0 to 200
  const cx = (worldX + 50) * 2;
  const cz = (worldZ + 50) * 2;
  return [cx, cz];
}

function drawMinimap(): void {
  const ctx = minimapCanvas.getContext("2d");
  if (!ctx) return;

  const W = 200;
  const H = 200;

  // Background
  ctx.fillStyle = "#0f172a";
  ctx.fillRect(0, 0, W, H);

  // Grid lines every 10 world units (= 20 canvas pixels)
  ctx.strokeStyle = "#1e293b";
  ctx.lineWidth = 0.5;
  for (let i = 0; i <= 10; i++) {
    const pos = i * 20;
    ctx.beginPath();
    ctx.moveTo(pos, 0);
    ctx.lineTo(pos, H);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, pos);
    ctx.lineTo(W, pos);
    ctx.stroke();
  }

  // Origin crosshair
  const [ox, oz] = worldToCanvas(0, 0);
  ctx.strokeStyle = "#475569";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(ox - 5, oz);
  ctx.lineTo(ox + 5, oz);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(ox, oz - 5);
  ctx.lineTo(ox, oz + 5);
  ctx.stroke();

  // Obstacles
  for (const ob of OBSTACLES) {
    const [cx, cz] = worldToCanvas(ob.x, ob.z);
    ctx.fillStyle = "#1e293b";
    ctx.beginPath();
    ctx.arc(cx, cz, ob.radius * 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#334155";
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // Agent dots
  for (const [, agent] of agents) {
    const [cx, cz] = worldToCanvas(agent.position.x, agent.position.z);
    // Clamp to canvas
    if (cx < 0 || cx > W || cz < 0 || cz > H) continue;
    ctx.fillStyle = agent.profile.color || "#888";
    ctx.beginPath();
    ctx.arc(cx, cz, 4, 0, Math.PI * 2);
    ctx.fill();
    // White outline for visibility
    ctx.strokeStyle = "rgba(255,255,255,0.3)";
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

// ── Agent List ───────────────────────────────────────────────

function updateAgentList(): void {
  const sorted = [...agents.values()].sort((a, b) =>
    a.profile.name.localeCompare(b.profile.name)
  );

  if (sorted.length === 0) {
    agentListEl.innerHTML =
      '<div class="feed-empty">No agents connected</div>';
    return;
  }

  agentListEl.innerHTML = sorted
    .map(
      (a) => `<div class="agent-row">
      <span class="agent-dot" style="background:${escapeHtml(a.profile.color || "#888")}"></span>
      <span class="agent-name" title="${escapeHtml(a.profile.agentId)}">${escapeHtml(a.profile.name)}</span>
      <span class="agent-action">${escapeHtml(a.action)}</span>
      <span class="agent-pos">(${a.position.x.toFixed(1)}, ${a.position.z.toFixed(1)})</span>
    </div>`
    )
    .join("");
}

// ── Broadcast Panel ──────────────────────────────────────────

function initBroadcastPanel(): void {
  broadcastSendBtn.addEventListener("click", async () => {
    const text = broadcastInput.value.trim();
    if (!text) return;
    const token = getToken();
    if (!token) return showToast("Not authenticated");
    try {
      const res = await fetch(`${API_BASE}/api/admin/broadcast`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ text }),
      });
      const data = await res.json();
      if (data.ok) {
        broadcastInput.value = "";
        showToast("Broadcast sent");
      } else {
        showToast(data.error || "Broadcast failed");
      }
    } catch {
      showToast("Failed to send broadcast");
    }
  });

  broadcastInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      broadcastSendBtn.click();
    }
  });

  rallyBtn.addEventListener("click", async () => {
    const token = getToken();
    if (!token) return showToast("Not authenticated");
    try {
      const res = await fetch(`${API_BASE}/api/admin/rally`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ x: 0, z: 0 }),
      });
      const data = await res.json();
      if (data.ok) {
        showToast(`Rallied ${data.moved} agent${data.moved !== 1 ? "s" : ""} to origin`);
      } else {
        showToast(data.error || "Rally failed");
      }
    } catch {
      showToast("Failed to rally agents");
    }
  });
}

// ── Event Listeners ──────────────────────────────────────────

loginForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const pw = passwordInput.value.trim();
  if (pw) login(pw);
});

logoutBtn.addEventListener("click", () => {
  clearToken();
  showLogin();
});

feedTypeFilter.addEventListener("change", () => {
  renderFeed();
});

initBroadcastPanel();

// ── Init ─────────────────────────────────────────────────────

(async () => {
  if (await validateSession()) {
    showAdmin();
  } else {
    clearToken();
    showLogin();
  }
})();
