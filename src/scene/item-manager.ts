import * as THREE from "three";
import { CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { generateModel } from "./generate-model.js";
import type { ObjectType } from "../../server/types.js";
import { serverBaseUrl } from "../main.js";

interface ItemEntry {
  group: THREE.Group;
  label: CSS2DObject;
  objectTypeId: string;
  name: string;
  color: string;
  time: number;
  loaded: boolean;
}

/** Volume target for items (~ 5x5x5 cube) */
const ITEM_VOLUME = 125;

/** Simple colored sphere shown instantly while the LLM model loads */
function createPlaceholderSphere(color: string): THREE.Group {
  const g = new THREE.Group();
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.15, 12, 8),
    new THREE.MeshToonMaterial({ color: new THREE.Color(color) }),
  );
  mesh.position.y = 0.15;
  mesh.castShadow = true;
  g.add(mesh);
  return g;
}

// ── ItemManager ─────────────────────────────────────────────────

export class ItemManager {
  private scene: THREE.Scene;
  private items = new Map<string, ItemEntry>();
  private objectTypes = new Map<string, ObjectType>();
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  updateObjectTypes(types: Record<string, ObjectType>): void {
    for (const [id, type] of Object.entries(types)) {
      this.objectTypes.set(id, type);
    }
  }

  addItem(itemId: string, objectTypeId: string, name: string, color: string, x: number, z: number): void {
    if (this.items.has(itemId)) return;

    const group = new THREE.Group();
    group.position.set(x, 0, z);
    group.userData.itemId = itemId;
    group.name = `item_${itemId}`;

    // Small colored sphere as instant placeholder while LLM model loads
    const placeholder = createPlaceholderSphere(color);
    placeholder.name = "placeholder";
    group.add(placeholder);

    // Glow ring on ground
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.3, 0.5, 16),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.3, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.02;
    ring.name = "ring";
    group.add(ring);

    // CSS2D label
    const labelEl = document.createElement("div");
    labelEl.className = "item-label";
    labelEl.textContent = name;
    labelEl.style.borderColor = color;
    const label = new CSS2DObject(labelEl);
    label.position.set(0, 1.2, 0);
    group.add(label);

    this.scene.add(group);

    const entry: ItemEntry = {
      group,
      label,
      objectTypeId,
      name,
      color,
      time: Math.random() * Math.PI * 2,
      loaded: false,
    };
    this.items.set(itemId, entry);

    // Async-load LLM-generated 3D model and swap it in
    generateModel(objectTypeId, name, { targetVolume: ITEM_VOLUME, apiBase: serverBaseUrl })
      .then((model) => {
        if (!model) return;
        const current = this.items.get(itemId);
        if (!current) {
          // Item was removed while loading — dispose the model
          model.traverse((child) => {
            if (child instanceof THREE.Mesh) {
              child.geometry?.dispose();
              if (child.material) {
                (Array.isArray(child.material) ? child.material : [child.material]).forEach((m) => m.dispose());
              }
            }
          });
          return;
        }

        // Remove placeholder sphere
        const ph = current.group.getObjectByName("placeholder");
        if (ph) {
          ph.traverse((child) => {
            if (child instanceof THREE.Mesh) {
              child.geometry?.dispose();
              if (child.material) {
                (Array.isArray(child.material) ? child.material : [child.material]).forEach((m) => m.dispose());
              }
            }
          });
          current.group.remove(ph);
        }

        model.position.y = 0.5;
        model.name = "model";
        model.userData.itemId = itemId;
        current.group.add(model);
        current.loaded = true;
      })
      .catch(() => {
        // Keep placeholder sphere — model generation unavailable
      });
  }

  removeItem(itemId: string): void {
    const entry = this.items.get(itemId);
    if (!entry) return;

    entry.label.element.remove();
    entry.label.removeFromParent();

    entry.group.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.geometry?.dispose();
        if (child.material) {
          (Array.isArray(child.material) ? child.material : [child.material]).forEach((m) => m.dispose());
        }
      }
    });

    this.scene.remove(entry.group);
    this.items.delete(itemId);
  }

  /** Per-frame update: gentle bobbing and rotation */
  update(delta: number): void {
    for (const entry of this.items.values()) {
      entry.time += delta;
      // Bobbing — apply to placeholder or loaded model
      const target = entry.group.getObjectByName("model") ?? entry.group.getObjectByName("placeholder");
      if (target) {
        target.position.y = (entry.loaded ? 0.5 : 0) + Math.sin(entry.time * 2) * 0.1;
      }
      // Slow rotation
      entry.group.rotation.y += delta * 0.5;
    }
  }

  /** Raycaster pick: returns itemId of clicked item, or null */
  pick(event: MouseEvent, camera: THREE.Camera, domElement: HTMLElement): string | null {
    const rect = domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, camera);

    const meshes: THREE.Mesh[] = [];
    for (const entry of this.items.values()) {
      entry.group.traverse((child) => {
        if (child instanceof THREE.Mesh) meshes.push(child);
      });
    }

    const hits = this.raycaster.intersectObjects(meshes, false);
    if (hits.length === 0) return null;

    let obj: THREE.Object3D | null = hits[0].object;
    while (obj) {
      if (obj.userData.itemId) return obj.userData.itemId as string;
      obj = obj.parent;
    }
    return null;
  }

  clear(): void {
    for (const itemId of Array.from(this.items.keys())) {
      this.removeItem(itemId);
    }
  }
}
