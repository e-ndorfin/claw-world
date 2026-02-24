// ── Event log viewer ──────────────────────────────────────────

interface LogEvent {
  tick: number;
  ts: string;
  type: string;
  agentId: string;
  data: Record<string, unknown>;
}

const API_BASE = "/api";

const fileSelect = document.getElementById("log-file") as HTMLSelectElement;
const refreshBtn = document.getElementById("refresh-btn") as HTMLButtonElement;
const liveToggle = document.getElementById("live-toggle") as HTMLInputElement;
const searchInput = document.getElementById("search") as HTMLInputElement;
const typeFilter = document.getElementById("type-filter") as HTMLSelectElement;
const agentInput = document.getElementById("agent-filter") as HTMLInputElement;
const countEl = document.getElementById("event-count")!;
const listEl = document.getElementById("event-list")!;
const detailEl = document.getElementById("event-detail")!;
const detailTitle = document.getElementById("detail-title")!;
const detailJson = document.getElementById("detail-json")!;
const detailClose = document.getElementById("detail-close")!;

let allEvents: LogEvent[] = [];
let liveInterval: ReturnType<typeof setInterval> | null = null;

// ── API calls ─────────────────────────────────────────────────

async function fetchLogFiles(): Promise<string[]> {
  const res = await fetch(`${API_BASE}/logs`);
  const data = await res.json();
  return data.files ?? [];
}

async function fetchEvents(filename: string): Promise<LogEvent[]> {
  const res = await fetch(`${API_BASE}/logs/${filename}`);
  const data = await res.json();
  return data.events ?? [];
}

// ── Rendering ─────────────────────────────────────────────────

function getEventSummary(ev: LogEvent): string {
  const d = ev.data;
  switch (ev.type) {
    case "chat":
      return `<span class="chat-text">"${escapeHtml(String(d.text ?? ""))}"</span>`;
    case "join": {
      const name = d.name ?? ev.agentId;
      const color = d.color ?? "";
      return `<b>${escapeHtml(String(name))}</b> joined` + (color ? ` <span style="color:${color}">●</span>` : "");
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

function formatTime(ts: string): string {
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return ts;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function syntaxHighlight(json: string): string {
  return json.replace(
    /("(?:\\.|[^"\\])*")\s*:/g,
    '<span class="json-key">$1</span>:'
  ).replace(
    /:\s*("(?:\\.|[^"\\])*")/g,
    ': <span class="json-string">$1</span>'
  ).replace(
    /:\s*(\d+\.?\d*)/g,
    ': <span class="json-number">$1</span>'
  ).replace(
    /:\s*(true|false)/g,
    ': <span class="json-bool">$1</span>'
  ).replace(
    /:\s*(null)/g,
    ': <span class="json-null">$1</span>'
  );
}

function renderEvents(events: LogEvent[]): void {
  if (events.length === 0) {
    listEl.innerHTML = `
      <div class="empty-state">
        <h2>No events yet</h2>
        <p>Start the server and register some agents to see events here.</p>
      </div>`;
    countEl.textContent = "0 events";
    return;
  }

  countEl.textContent = `${events.length} event${events.length !== 1 ? "s" : ""}`;

  const html = events.map((ev, i) => `
    <div class="event-row" data-idx="${i}">
      <span class="event-time">${formatTime(ev.ts)}</span>
      <span class="event-badge badge-${ev.type}">${ev.type}</span>
      <span class="event-agent" title="${escapeHtml(ev.agentId)}">${escapeHtml(ev.agentId)}</span>
      <span class="event-content">${getEventSummary(ev)}</span>
      <span class="event-tick">tick ${ev.tick}</span>
    </div>
  `).join("");

  listEl.innerHTML = html;

  // Click to show detail
  listEl.querySelectorAll(".event-row").forEach((row) => {
    row.addEventListener("click", () => {
      const idx = Number((row as HTMLElement).dataset.idx);
      showDetail(events[idx]);
    });
  });
}

function showDetail(ev: LogEvent): void {
  detailTitle.textContent = `${ev.type.toUpperCase()} — ${ev.agentId} — ${formatTime(ev.ts)}`;
  detailJson.innerHTML = syntaxHighlight(JSON.stringify(ev.data, null, 2));
  detailEl.classList.remove("hidden");
}

// ── Filtering ─────────────────────────────────────────────────

function applyFilters(): void {
  const q = searchInput.value.toLowerCase();
  const type = typeFilter.value;
  const agent = agentInput.value.trim().toLowerCase();

  let filtered = allEvents;

  if (type) filtered = filtered.filter((e) => e.type === type);
  if (agent) filtered = filtered.filter((e) => e.agentId.toLowerCase().includes(agent));
  if (q) filtered = filtered.filter((e) => JSON.stringify(e).toLowerCase().includes(q));

  renderEvents([...filtered].reverse());
}

// ── File selection & loading ──────────────────────────────────

async function loadFileList(): Promise<void> {
  const files = await fetchLogFiles();
  fileSelect.innerHTML = files.length
    ? files.map((f) => `<option value="${f}">${f.replace("events-", "").replace(".jsonl", "")}</option>`).join("")
    : '<option value="">No log files</option>';

  if (files.length) await loadEvents(files[0]);
}

async function loadEvents(filename: string): Promise<void> {
  allEvents = await fetchEvents(filename);
  applyFilters();
}

// ── Live polling ──────────────────────────────────────────────

function startLive(): void {
  if (liveInterval) return;
  liveInterval = setInterval(async () => {
    if (!fileSelect.value) return;
    const prevCount = allEvents.length;
    allEvents = await fetchEvents(fileSelect.value);
    if (allEvents.length !== prevCount) {
      applyFilters();
      // Auto-scroll to top (newest first)
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }, 2000);
}

function stopLive(): void {
  if (liveInterval) {
    clearInterval(liveInterval);
    liveInterval = null;
  }
}

// ── Event listeners ───────────────────────────────────────────

fileSelect.addEventListener("change", () => {
  if (fileSelect.value) loadEvents(fileSelect.value);
});

refreshBtn.addEventListener("click", () => {
  if (fileSelect.value) loadEvents(fileSelect.value);
});

liveToggle.addEventListener("change", () => {
  if (liveToggle.checked) startLive();
  else stopLive();
});

searchInput.addEventListener("input", applyFilters);
typeFilter.addEventListener("change", applyFilters);
agentInput.addEventListener("input", applyFilters);

detailClose.addEventListener("click", () => {
  detailEl.classList.add("hidden");
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") detailEl.classList.add("hidden");
});

// ── Init ──────────────────────────────────────────────────────

loadFileList();
startLive();
