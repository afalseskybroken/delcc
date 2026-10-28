// delcc-app/src/lib/secure.ts — pass #78 (Sonnet S2): DPAPI-backed key/value store.
// Tokens and profiles live here (Rust shell: CryptProtectData blobs under the app-data
// dir) instead of plaintext localStorage. Every call degrades honestly in plain-browser
// dev (no shell): get → null, put → false, del → noop; callers keep their documented
// localStorage fallback, which is a dev lane, not a shipped posture (SECURITY.md).
import { logError } from "./applog";
import { shellInvoke } from "./transport";

// null = nothing stored under this name (first boot) — also returned when no shell.
export async function secureGet(name: string): Promise<string | null> {
  const inv = await shellInvoke();
  if (!inv) return null;
  try {
    return (await inv("secure_get", { name })) as string | null;
  } catch (e) {
    logError(`secure get ${name}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

// true = stored encrypted; false = no shell or the shell refused (caller falls back).
export async function securePut(name: string, plaintext: string): Promise<boolean> {
  const inv = await shellInvoke();
  if (!inv) return false;
  try {
    await inv("secure_put", { name, plaintext });
    return true;
  } catch (e) {
    logError(`secure put ${name}: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

export async function secureDel(name: string): Promise<void> {
  const inv = await shellInvoke();
  if (!inv) return;
  try {
    await inv("secure_del", { name });
  } catch (e) {
    logError(`secure del ${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
