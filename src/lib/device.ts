export function deviceId(): string {
  try {
    let d = localStorage.getItem("delcc-device") || "";
    if (!d) {
      d = "delcc-" + Array.from(crypto.getRandomValues(new Uint8Array(16)))
        .map((b) => b.toString(16).padStart(2, "0")).join("");
      localStorage.setItem("delcc-device", d);
    }
    return d;
  } catch { return "delcc-session"; }
}
