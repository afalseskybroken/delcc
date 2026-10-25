// delcc-app/src/lib/updater.ts
// "no forced updates" is the whole pitch of this client. This checks what the
// official tmath-tauri-client feed says and tells the user — it never downloads,
// installs, or restarts anything by itself. delcc is not published on this feed;
// its own version lives in tauri.conf.json / Cargo.toml, unrelated to this check.
import { api, type ReleaseManifest } from "./api";

const LS = "delcc-last-seen-release";

export interface UpdateNotice {
  version: string;
  prevVersion: string | null;
  manifest: ReleaseManifest;
}

// null = nothing to show (dev channel, or server version unchanged since last boot that showed a banner).
export async function checkForUpdate(platform = "windows-x64"): Promise<UpdateNotice | null> {
  const m = await api.release(platform); // raw() already retries once on 426 via X-Client-Version bump
  if (!m?.required_version) return null; // malformed feed — never paint a meaningless banner
  const prev = (() => { try { return localStorage.getItem(LS); } catch { return null; } })();
  if (prev === m.required_version) return null; // already told the user about this exact version
  try { localStorage.setItem(LS, m.required_version); } catch { /* private mode — reshow next boot, fine */ }
  if (prev === null) return null; // first run on this profile: nothing to compare against yet, stay quiet
  if ("development" in m && m.development) return null; // dev channel manifest carries no installer
  return { version: m.required_version, prevVersion: prev, manifest: m };
}

export async function recordDownload(platform: string, releaseId: string): Promise<void> {
  try { await api.recordDownload(platform, releaseId); } catch { /* best-effort stat, never block the user on it */ }
}
