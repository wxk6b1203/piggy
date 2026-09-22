/** 应用内轻事件（解耦 store ↔ 视图刷新，避免轮询） */
type Handler = (payload?: string) => void;

const map = new Map<string, Set<Handler>>();

export const windowEvents = {
  on(name: string, h: Handler): () => void {
    if (!map.has(name)) map.set(name, new Set());
    map.get(name)!.add(h);
    return () => map.get(name)?.delete(h);
  },
  emit(name: string, payload?: string) {
    map.get(name)?.forEach((h) => h(payload));
  },
};
