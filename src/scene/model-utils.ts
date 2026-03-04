import * as THREE from "three";

/** Default bounding-box volume target (~ 2x2x2 cube) */
export const DEFAULT_VOLUME = 8;

/** Scale a group so its bounding-box volume matches `targetVolume`. */
export function normalizeVolume(group: THREE.Group, targetVolume: number): void {
  const box = new THREE.Box3().setFromObject(group);
  const size = box.getSize(new THREE.Vector3());
  const volume = size.x * size.y * size.z;
  if (volume > 0) {
    const scale = Math.cbrt(targetVolume / volume);
    group.scale.setScalar(scale);
  }
}
