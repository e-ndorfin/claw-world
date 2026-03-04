interface CacheEntry {
  name: string;
  code: string;
}

const map = new Map<string, CacheEntry>();

export const objectCache = {
  get(key: string): CacheEntry | undefined {
    return map.get(key);
  },
  set(key: string, name: string, code: string): void {
    map.set(key, { name, code });
  },
};
