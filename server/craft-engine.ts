/** Hardcoded recipes used as last-resort fallback when LLM call fails (network error, timeout) */
const HARDCODED_RECIPES: Record<string, { name: string; color: string }> = {
  "fire+water": { name: "Steam", color: "#d5d5d5" },
  "earth+fire": { name: "Lava", color: "#e25822" },
  "earth+water": { name: "Mud", color: "#6b4226" },
  "air+fire": { name: "Smoke", color: "#708090" },
  "air+water": { name: "Cloud", color: "#f0f0f0" },
  "air+earth": { name: "Dust", color: "#c2b280" },
  "fire+stone": { name: "Obsidian", color: "#1b1b2f" },
  "fire+wood": { name: "Charcoal", color: "#36454f" },
  "stone+water": { name: "Clay", color: "#b66a50" },
  "fire+sand": { name: "Glass", color: "#e8e8e8" },
  "fire+ice": { name: "Water", color: "#3498db" },
  "ice+lightning": { name: "Frost", color: "#c8e8ff" },
  "earth+moss": { name: "Grass", color: "#7cfc00" },
  "moss+water": { name: "Algae", color: "#4a7c59" },
  "lightning+sand": { name: "Fulgurite", color: "#c5b358" },
  "lightning+water": { name: "Plasma", color: "#ff69b4" },
  "sand+water": { name: "Sandcastle", color: "#e8d5a3" },
  "stone+wood": { name: "Axe", color: "#808080" },
  "air+ice": { name: "Blizzard", color: "#b0e0e6" },
  "earth+stone": { name: "Mountain", color: "#696969" },
  "water+wood": { name: "Boat", color: "#deb887" },
  "fire+moss": { name: "Ash", color: "#b2beb5" },
  "ice+stone": { name: "Glacier", color: "#71a6d2" },
  "lightning+wood": { name: "Fire", color: "#e74c3c" },
};

export class CraftEngine {
  private apiKey: string | undefined;

  constructor() {
    this.apiKey = process.env.OPENROUTER_API_KEY;
  }

  async combine(
    name1: string,
    name2: string,
    existingNames: string[],
  ): Promise<{ name: string; color: string }> {
    if (!this.apiKey) {
      throw new Error("OPENROUTER_API_KEY is not set — cannot craft without LLM");
    }

    try {
      return await this.llmCombine(name1, name2, existingNames);
    } catch (err) {
      console.warn("[craft] LLM call failed, trying hardcoded recipes:", err);

      // Last-resort: hardcoded dictionary for known combos
      const a = name1.toLowerCase();
      const b = name2.toLowerCase();
      const key = a < b ? `${a}+${b}` : `${b}+${a}`;
      if (HARDCODED_RECIPES[key]) {
        return HARDCODED_RECIPES[key];
      }

      throw new Error(`Crafting failed: LLM unavailable and no hardcoded recipe for ${name1} + ${name2}`);
    }
  }

  private async llmCombine(
    name1: string,
    name2: string,
    existingNames: string[],
  ): Promise<{ name: string; color: string }> {
    const prompt = `You are the crafting oracle for a Little Alchemy-style game. A player is combining two elements.

Ingredient 1: ${name1}
Ingredient 2: ${name2}

What does combining these two create? Respond with a JSON object:
{
  "name": "ResultName",
  "color": "#hexcolor"
}

Rules:
- The result should be creative but logical (like real Little Alchemy)
- Use a single word or two-word name
- Pick a color that visually represents the result
- If combining identical elements, create a "bigger" or "pure" version
- Already discovered objects: ${existingNames.join(", ")}
- Do NOT reuse an already discovered name unless it truly is the correct result

Respond with ONLY the JSON object, no other text.`;

    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: "openai/gpt-4.1-nano",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.7,
        max_tokens: 200,
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      throw new Error(`OpenRouter returned ${response.status}`);
    }

    const data = await response.json() as {
      choices: { message: { content: string | null; reasoning?: string } }[];
    };

    const msg = data.choices?.[0]?.message;
    const content = (msg?.content ?? msg?.reasoning ?? "").trim();
    if (!content) throw new Error("Empty LLM response");
    console.log("[craft] LLM raw response:", content.slice(0, 300));

    // Extract JSON from response (handle markdown code blocks)
    const jsonMatch = content.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) throw new Error("No JSON in response");

    const parsed = JSON.parse(jsonMatch[0]) as { name: string; color: string };
    if (!parsed.name || !parsed.color) throw new Error("Invalid JSON structure");

    return {
      name: parsed.name.slice(0, 30),
      color: parsed.color.startsWith("#") ? parsed.color : `#${parsed.color}`,
    };
  }
}
