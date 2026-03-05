import * as THREE from "three";
import { normalizeVolume, DEFAULT_VOLUME } from "./model-utils.js";

// Client-side cache to avoid redundant server calls
const cache = new Map<string, string>();

/**
 * Ask the server to generate procedural Three.js code for an object type,
 * then execute it client-side and return a volume-normalized THREE.Group.
 */
export async function generateModel(
  objectTypeId: string,
  name: string,
  opts: { targetVolume?: number; apiBase?: string } = {},
): Promise<THREE.Group | null> {
  if (!objectTypeId) return null;

  let code = cache.get(objectTypeId);

  if (!code) {
    try {
      const base = opts.apiBase ?? "";
      const res = await fetch(`${base}/api/generate-object`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ objectTypeId }),
      });
      const data = await res.json();
      if (!data.ok || !data.code) return null;
      code = data.code as string;
      cache.set(objectTypeId, code);
    } catch (err) {
      console.error("[generateModel] fetch failed:", err);
      return null;
    }
  }

  try {
    const fn = new Function("THREE", code) as (t: typeof THREE) => THREE.Group;
    const group = fn(THREE);
    normalizeVolume(group, opts.targetVolume ?? DEFAULT_VOLUME);
    return group;
  } catch (err) {
    console.error("[generateModel] execution failed, using fallback:", err);
    // Fallback: magenta sphere (matches threejs-test pattern)
    const group = new THREE.Group();
    const geo = new THREE.SphereGeometry(0.5, 16, 16);
    const mat = new THREE.MeshStandardMaterial({ color: 0xff00ff });
    group.add(new THREE.Mesh(geo, mat));
    normalizeVolume(group, opts.targetVolume ?? DEFAULT_VOLUME);
    return group;
  }
}
