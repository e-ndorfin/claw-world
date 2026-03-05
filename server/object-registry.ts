import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ObjectType } from "./types.js";

const REGISTRY_PATH = resolve(process.cwd(), "object-registry.json");
const SAVE_DELAY_MS = 5000;

const BASE_OBJECTS: ObjectType[] = [
  { objectTypeId: "fire", name: "Fire", recipe: null, discoveredBy: null, discoveredAt: 0, color: "#e74c3c" },
  { objectTypeId: "water", name: "Water", recipe: null, discoveredBy: null, discoveredAt: 0, color: "#3498db" },
  { objectTypeId: "earth", name: "Earth", recipe: null, discoveredBy: null, discoveredAt: 0, color: "#8b4513" },
  { objectTypeId: "air", name: "Air", recipe: null, discoveredBy: null, discoveredAt: 0, color: "#ecf0f1" },
];

export { BASE_OBJECTS };

export class ObjectRegistry {
  private types = new Map<string, ObjectType>();
  private recipeIndex = new Map<string, string>(); // "a+b" → objectTypeId
  private dirty = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.load();
  }

  get(objectTypeId: string): ObjectType | undefined {
    return this.types.get(objectTypeId);
  }

  findByRecipe(a: string, b: string): ObjectType | undefined {
    const key = this.recipeKey(a, b);
    const id = this.recipeIndex.get(key);
    return id ? this.types.get(id) : undefined;
  }

  register(type: ObjectType): void {
    this.types.set(type.objectTypeId, type);
    if (type.recipe) {
      this.recipeIndex.set(this.recipeKey(type.recipe[0], type.recipe[1]), type.objectTypeId);
    }
    this.scheduleSave();
  }

  getAll(): Record<string, ObjectType> {
    const result: Record<string, ObjectType> = {};
    for (const [id, type] of this.types) {
      result[id] = type;
    }
    return result;
  }

  getAllArray(): ObjectType[] {
    return Array.from(this.types.values());
  }

  getBaseObjectIds(): string[] {
    return BASE_OBJECTS.map((b) => b.objectTypeId);
  }

  findByName(name: string): ObjectType | undefined {
    const lower = name.toLowerCase().trim();
    for (const t of this.types.values()) {
      if (t.name.toLowerCase() === lower) return t;
    }
    return undefined;
  }

  setCode(objectTypeId: string, code: string): void {
    const t = this.types.get(objectTypeId);
    if (t) {
      t.code = code;
      this.scheduleSave();
    }
  }

  /** Clear all types and recipes, re-seed only the 4 base objects. */
  resetToBase(): void {
    this.types.clear();
    this.recipeIndex.clear();
    for (const base of BASE_OBJECTS) {
      this.types.set(base.objectTypeId, { ...base });
    }
    this.scheduleSave();
  }

  private recipeKey(a: string, b: string): string {
    return a < b ? `${a}+${b}` : `${b}+${a}`;
  }

  private load(): void {
    try {
      if (existsSync(REGISTRY_PATH)) {
        const data = JSON.parse(readFileSync(REGISTRY_PATH, "utf-8"));
        if (Array.isArray(data)) {
          for (const t of data) {
            if (t.objectTypeId) {
              this.types.set(t.objectTypeId, t);
              if (t.recipe) {
                this.recipeIndex.set(this.recipeKey(t.recipe[0], t.recipe[1]), t.objectTypeId);
              }
            }
          }
        }
      }
    } catch {
      // Start fresh if corrupt
    }

    // Seed base objects if not present
    for (const base of BASE_OBJECTS) {
      if (!this.types.has(base.objectTypeId)) {
        this.types.set(base.objectTypeId, base);
        this.dirty = true;
      }
    }
    if (this.dirty) this.scheduleSave();
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
      writeFileSync(REGISTRY_PATH, JSON.stringify(this.getAllArray(), null, 2), "utf-8");
    } catch {
      // Non-fatal
    }
  }
}
