export type DependencyName = 'db' | 'cache' | 'rpc' | 'indexer' | 'coldStorage' | 'p2p' | 'worker';

const _state: Record<DependencyName, boolean> = {
  db: false,
  cache: false,
  rpc: false,
  indexer: false,
  coldStorage: false,
  p2p: true,
  worker: true,
};

export function markReady(dep: DependencyName): void {
  _state[dep] = true;
}

export function markNotReady(dep: DependencyName): void {
  _state[dep] = false;
}

export function getReadinessState(): Record<DependencyName, boolean> {
  return { ..._state };
}

export function isFullyReady(): boolean {
  return Object.values(_state).every(Boolean);
}
