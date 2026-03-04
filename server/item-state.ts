import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { WorldItem } from "./types.js";

const ITEMS_PATH = resolve(process.cwd(), "item-state.json");
const KNOWLEDGE_PATH = resolve(process.cwd(), "agent-knowledge.json");
const SAVE_DELAY_MS = 5000;

export class ItemState {
  private items = new Map<string, WorldItem>();
  private inventories = new Map<string, [string | null, string | null]>();
  private knowledge = new Map<string, Set<string>>();
  private dirty = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.load();
  }

  // ── Item lifecycle ──────────────────────────────────────────

  spawnItem(itemId: string, objectTypeId: string, x: number, z: number): WorldItem {
    const item: WorldItem = { itemId, objectTypeId, x, z, heldBy: null, slot: null };
    this.items.set(itemId, item);
    this.scheduleSave();
    return item;
  }

  removeItem(itemId: string): void {
    const item = this.items.get(itemId);
    if (!item) return;
    // If held, clear the inventory slot
    if (item.heldBy) {
      const inv = this.inventories.get(item.heldBy);
      if (inv && item.slot !== null) {
        inv[item.slot] = null;
      }
    }
    this.items.delete(itemId);
    this.scheduleSave();
  }

  getItem(itemId: string): WorldItem | undefined {
    return this.items.get(itemId);
  }

  getAllItems(): WorldItem[] {
    return Array.from(this.items.values());
  }

  getGroundItems(): WorldItem[] {
    return this.getAllItems().filter((i) => !i.heldBy);
  }

  // ── Inventory operations ────────────────────────────────────

  pickupItem(agentId: string, itemId: string): { ok: boolean; slot?: 0 | 1; reason?: string } {
    const item = this.items.get(itemId);
    if (!item) return { ok: false, reason: "Item not found" };
    if (item.heldBy) return { ok: false, reason: "Item is already held" };

    const inv = this.getOrCreateInventory(agentId);
    let freeSlot: 0 | 1 | null = null;
    if (inv[0] === null) freeSlot = 0;
    else if (inv[1] === null) freeSlot = 1;

    if (freeSlot === null) return { ok: false, reason: "Inventory full" };

    item.heldBy = agentId;
    item.slot = freeSlot;
    inv[freeSlot] = itemId;
    this.scheduleSave();
    return { ok: true, slot: freeSlot };
  }

  dropItem(agentId: string, slot: 0 | 1, x: number, z: number): WorldItem | null {
    const inv = this.inventories.get(agentId);
    if (!inv) return null;
    const itemId = inv[slot];
    if (!itemId) return null;

    const item = this.items.get(itemId);
    if (!item) return null;

    item.heldBy = null;
    item.slot = null;
    item.x = x;
    item.z = z;
    inv[slot] = null;
    this.scheduleSave();
    return item;
  }

  getInventory(agentId: string): [string | null, string | null] {
    return this.inventories.get(agentId) ?? [null, null];
  }

  /** Consume both inventory slots for crafting. Returns the two objectTypeIds. */
  craftConsume(agentId: string): { item1: WorldItem; item2: WorldItem } | null {
    const inv = this.inventories.get(agentId);
    if (!inv || !inv[0] || !inv[1]) return null;

    const item1 = this.items.get(inv[0]);
    const item2 = this.items.get(inv[1]);
    if (!item1 || !item2) return null;

    // Remove both items
    this.items.delete(inv[0]);
    this.items.delete(inv[1]);
    inv[0] = null;
    inv[1] = null;
    this.scheduleSave();
    return { item1, item2 };
  }

  /** Drop all held items when agent leaves */
  dropAllItems(agentId: string, x: number, z: number): WorldItem[] {
    const dropped: WorldItem[] = [];
    const inv = this.inventories.get(agentId);
    if (inv) {
      for (const slot of [0, 1] as const) {
        if (inv[slot]) {
          const item = this.items.get(inv[slot]!);
          if (item) {
            item.heldBy = null;
            item.slot = null;
            item.x = x + (Math.random() - 0.5) * 2;
            item.z = z + (Math.random() - 0.5) * 2;
            dropped.push(item);
          }
          inv[slot] = null;
        }
      }
    }
    if (dropped.length) this.scheduleSave();
    return dropped;
  }

  // ── Knowledge management ────────────────────────────────────

  initKnowledge(agentId: string, objectTypeIds: string[]): void {
    this.knowledge.set(agentId, new Set(objectTypeIds));
    this.scheduleSave();
  }

  addKnowledge(agentId: string, objectTypeId: string): void {
    const known = this.knowledge.get(agentId);
    if (known) {
      known.add(objectTypeId);
    } else {
      this.knowledge.set(agentId, new Set([objectTypeId]));
    }
    this.scheduleSave();
  }

  getKnowledge(agentId: string): string[] {
    const known = this.knowledge.get(agentId);
    return known ? Array.from(known) : [];
  }

  hasKnowledge(agentId: string, objectTypeId: string): boolean {
    return this.knowledge.get(agentId)?.has(objectTypeId) ?? false;
  }

  /** Get all base objectTypeIds currently assigned to online agents */
  getAssignedBaseObjects(onlineAgentIds: Set<string>): Set<string> {
    const assigned = new Set<string>();
    for (const agentId of onlineAgentIds) {
      const known = this.knowledge.get(agentId);
      if (known) {
        for (const id of known) assigned.add(id);
      }
    }
    return assigned;
  }

  // ── Persistence ─────────────────────────────────────────────

  private getOrCreateInventory(agentId: string): [string | null, string | null] {
    let inv = this.inventories.get(agentId);
    if (!inv) {
      inv = [null, null];
      this.inventories.set(agentId, inv);
    }
    return inv;
  }

  private load(): void {
    try {
      if (existsSync(ITEMS_PATH)) {
        const data = JSON.parse(readFileSync(ITEMS_PATH, "utf-8"));
        if (Array.isArray(data)) {
          for (const item of data) {
            if (item.itemId) {
              this.items.set(item.itemId, item);
              if (item.heldBy && item.slot !== null) {
                const inv = this.getOrCreateInventory(item.heldBy);
                inv[item.slot] = item.itemId;
              }
            }
          }
        }
      }
    } catch {
      // Start fresh
    }

    try {
      if (existsSync(KNOWLEDGE_PATH)) {
        const data = JSON.parse(readFileSync(KNOWLEDGE_PATH, "utf-8"));
        if (typeof data === "object" && data !== null) {
          for (const [agentId, ids] of Object.entries(data)) {
            if (Array.isArray(ids)) {
              this.knowledge.set(agentId, new Set(ids as string[]));
            }
          }
        }
      }
    } catch {
      // Start fresh
    }
  }

  private scheduleSave(): void {
    this.dirty = true;
    if (!this.saveTimer) {
      this.saveTimer = setTimeout(() => {
        this.saveTimer = null;
        this.flush();
      }, SAVE_DELAY_MS);
    }
  }

  flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      writeFileSync(ITEMS_PATH, JSON.stringify(this.getAllItems(), null, 2), "utf-8");
    } catch {
      // Non-fatal
    }
    try {
      const knowledgeObj: Record<string, string[]> = {};
      for (const [agentId, known] of this.knowledge) {
        knowledgeObj[agentId] = Array.from(known);
      }
      writeFileSync(KNOWLEDGE_PATH, JSON.stringify(knowledgeObj, null, 2), "utf-8");
    } catch {
      // Non-fatal
    }
  }
}
