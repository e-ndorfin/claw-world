import * as THREE from "three";

/** Default bounding-box volume target (~ 5x5x5 cube) */
export const DEFAULT_VOLUME = 125;

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
