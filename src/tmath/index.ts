import { TmathApp } from "./app";

let current: TmathApp | null = null;
export async function bootTmath(host = document.getElementById("app")): Promise<void> {
  if (!host) throw new Error("TMATH mount element is missing");
  current?.destroy();
  current = new TmathApp(host);
  await current.start();
}
