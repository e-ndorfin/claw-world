// ── Agent Skill Declaration ────────────────────────────────────

export interface AgentSkillDeclaration {
  skillId: string;      // e.g. "code-review", "web-research"
  name: string;         // Human-readable
  description?: string; // What this agent does with this skill
}

// ── Agent Profile ──────────────────────────────────────────────

export interface AgentProfile {
  agentId: string;
  name: string;
  pubkey: string;
  bio: string;
  capabilities: string[];
  skills?: AgentSkillDeclaration[];
  color: string;
  avatar?: string;
  joinedAt: number;
  lastSeen: number;
}

// ── World Position ─────────────────────────────────────────────

export interface AgentPosition {
  agentId: string;
  x: number;
  y: number;
  z: number;
  rotation: number;
  timestamp: number;
}

// ── Crafting System Types ──────────────────────────────────────

/** A discovered object type in the global registry */
export interface ObjectType {
  objectTypeId: string;
  name: string;
  recipe: [string, string] | null;
  discoveredBy: string | null;
  discoveredAt: number;
  color: string;
  code?: string;
}

/** A world item instance (placed on the ground or held) */
export interface WorldItem {
  itemId: string;
  objectTypeId: string;
  x: number;
  z: number;
  heldBy: string | null;
  slot: 0 | 1 | null;
}

/** Distance within which an agent can pick up an item */
export const ITEM_PICKUP_RADIUS = 3;

// ── World Messages (kind 42 broadcast) ─────────────────────────

export type WorldMessage =
  | PositionMessage
  | ActionMessage
  | EmoteMessage
  | ChatMessage
  | JoinMessage
  | LeaveMessage
  | ProfileMessage
  | ItemSpawnMessage
  | ItemPickupMessage
  | ItemDropMessage
  | ItemCraftMessage
  | ItemDespawnMessage;

export interface PositionMessage {
  worldType: "position";
  agentId: string;
  x: number;
  y: number;
  z: number;
  rotation: number;
  timestamp: number;
}

export interface ActionMessage {
  worldType: "action";
  agentId: string;
  action: "walk" | "idle" | "wave" | "pinch" | "talk" | "dance" | "backflip" | "spin";
  targetAgentId?: string;
  timestamp: number;
}

export interface EmoteMessage {
  worldType: "emote";
  agentId: string;
  emote: "happy" | "thinking" | "surprised" | "laugh";
  timestamp: number;
}

export interface ChatMessage {
  worldType: "chat";
  agentId: string;
  text: string;
  timestamp: number;
}

export interface JoinMessage {
  worldType: "join";
  agentId: string;
  name: string;
  color: string;
  bio: string;
  capabilities: string[];
  skills?: AgentSkillDeclaration[];
  timestamp: number;
}

export interface LeaveMessage {
  worldType: "leave";
  agentId: string;
  timestamp: number;
}

export interface ProfileMessage {
  worldType: "profile";
  agentId: string;
  name: string;
  bio: string;
  capabilities: string[];
  color: string;
  timestamp: number;
}

// ── Item Messages ─────────────────────────────────────────────

export interface ItemSpawnMessage {
  worldType: "item-spawn";
  agentId: string;
  itemId: string;
  objectTypeId: string;
  name: string;
  color: string;
  x: number;
  z: number;
  timestamp: number;
}

export interface ItemPickupMessage {
  worldType: "item-pickup";
  agentId: string;
  itemId: string;
  slot: 0 | 1;
  timestamp: number;
}

export interface ItemDropMessage {
  worldType: "item-drop";
  agentId: string;
  itemId: string;
  x: number;
  z: number;
  timestamp: number;
}

export interface ItemCraftMessage {
  worldType: "item-craft";
  agentId: string;
  consumed: [string, string];
  ingredient1Name: string;
  ingredient2Name: string;
  resultItemId: string;
  resultObjectTypeId: string;
  resultName: string;
  resultColor: string;
  isNewDiscovery: boolean;
  x: number;
  z: number;
  timestamp: number;
}

export interface ItemDespawnMessage {
  worldType: "item-despawn";
  itemId: string;
  timestamp: number;
}

// ── Room info ─────────────────────────────────────────────────

export interface RoomInfoMessage {
  roomId: string;
  name: string;
  description: string;
  agents: number;
  maxAgents: number;
  nostrChannelId: string | null;
}

// ── WebSocket messages (server ↔ browser) ──────────────────────

export type WSServerMessage =
  | { type: "snapshot"; agents: AgentState[] }
  | { type: "world"; message: WorldMessage }
  | { type: "profiles"; profiles: AgentProfile[] }
  | { type: "profile"; profile: AgentProfile }
  | { type: "roomInfo"; info: RoomInfoMessage }
  | { type: "itemSnapshot"; items: WorldItem[]; objectTypes: Record<string, ObjectType> };

export type WSClientMessage =
  | { type: "subscribe" }
  | { type: "requestProfiles" }
  | { type: "requestProfile"; agentId: string }
  | { type: "viewport"; x: number; z: number }
  | { type: "follow"; agentId: string }
  | { type: "requestRoomInfo" };

// ── Combined agent state for snapshot ──────────────────────────

export interface AgentState {
  profile: AgentProfile;
  position: AgentPosition;
  action: string;
}

// ── Proximity constants ────────────────────────────────────────

/** Distance within which labels/bubbles are visible */
export const PROXIMITY_RADIUS = 25;

/** World bounds (100x100 room) */
export const WORLD_SIZE = 100;
