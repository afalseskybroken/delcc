// delcc-side facade for the vendored AGE embed (the implementation lives in embed.tsx,
// which is excluded from tsc — upstream typing friction; vite transpiles it).
export interface AgeData {
  edgesText: string;
  rootsText: string; // pass #114: roots + isolated vertices (tree layering starts here)
  labelOffset: number; // pass #114: displayed relabel (Official's Đổi nhãn số)
  directed: boolean;
  tree: boolean;
  lock: boolean;
  dark: boolean;
}
export function mountAge(host: HTMLElement, data: AgeData): void;
export function updateAge(data: AgeData): void;
export function unmountAge(): void;
