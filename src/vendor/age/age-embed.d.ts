// delcc-side facade for the vendored AGE embed (the implementation lives in embed.tsx,
// which is excluded from tsc — upstream typing friction; vite transpiles it).
export interface AgeData {
  edgesText: string;
  directed: boolean;
  tree: boolean;
  lock: boolean;
  physics: boolean;
  dark: boolean;
}
export function mountAge(host: HTMLElement, data: AgeData): void;
export function updateAge(data: AgeData): void;
export function unmountAge(): void;
