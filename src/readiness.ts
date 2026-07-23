export type DependencyName = 'db' | 'cache' | 'indexer' | 'coldStorage' | 'p2p';

const _state: Record<DependencyName, boolean> = {
  db: false,
  cache: false,
  indexer: false,
  coldStorage: false,
  // p2p starts ready: single-node deployments (P2P_ENABLED unset) never touch
  // this dependency, so it must not block /readyz. P2P-enabled nodes flip it
  // false until startP2pNode() completes (see src/p2p/index.ts).
  p2p: true,
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
