import { readFileSync } from "node:fs";
import { resolve } from "node:path";

interface RecipeEntry {
  name: string;
  objectTypeId: string;
}

/** Convert a display name to an objectTypeId: lowercase, spaces→hyphens, strip non-alphanumeric */
function nameToId(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

/** Title-case a recipe name: "acid rain" → "Acid Rain" */
function titleCase(name: string): string {
  return name.replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Deterministic HSL color from a string hash */
export function generateColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  const h = ((hash >>> 0) % 360);
  const s = 40 + ((hash >>> 8) % 30);   // 40-69%
  const l = 35 + ((hash >>> 16) % 30);  // 35-64%
  return `hsl(${h}, ${s}%, ${l}%)`;
}

export class CraftEngine {
  private combos = new Map<string, RecipeEntry[]>();
  private elementCount = 0;

  constructor() {
    this.loadRecipes();
  }

  /** Look up a recipe by two objectTypeIds. Returns first match or null. */
  lookup(id1: string, id2: string): { name: string; objectTypeId: string } | null {
    const key = id1 < id2 ? `${id1}+${id2}` : `${id2}+${id1}`;
    const results = this.combos.get(key);
    return results?.[0] ?? null;
  }

  private loadRecipes(): void {
    const jsonPath = resolve(process.cwd(), "server", "little-alchemy-recipes.json");
    const raw = JSON.parse(readFileSync(jsonPath, "utf-8")) as Record<string, string[][]>;

    for (const [resultName, recipes] of Object.entries(raw)) {
      const resultId = nameToId(resultName);

      for (const ingredients of recipes) {
        if (ingredients.length !== 2) continue;

        const ingId1 = nameToId(ingredients[0]);
        const ingId2 = nameToId(ingredients[1]);
        const key = ingId1 < ingId2 ? `${ingId1}+${ingId2}` : `${ingId2}+${ingId1}`;

        let arr = this.combos.get(key);
        if (!arr) {
          arr = [];
          this.combos.set(key, arr);
        }
        arr.push({ name: titleCase(resultName), objectTypeId: resultId });
      }
    }

    this.elementCount = Object.keys(raw).length;
    console.log(`[craft] Loaded ${this.combos.size} recipe combos for ${this.elementCount} elements`);
  }
}
