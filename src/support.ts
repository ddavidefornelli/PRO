import { invoke, isTauri } from "@tauri-apps/api/core";
import { element } from "./dom";

export function supportFooter(): HTMLElement {
  const footer = element("footer", undefined, "support-footer");
  const link = element("a", "fornelli.dv@gmail.com");
  link.href = "mailto:fornelli.dv@gmail.com";
  link.addEventListener("click", async (event) => {
    if (!isTauri()) return; // Browser previews can use their normal mailto handler.
    event.preventDefault();
    try {
      // A fixed native target, not an arbitrary URL-opening IPC permission.
      await invoke("open_support_email");
    } catch {
      window.alert("Could not open your email app. You can contact me at fornelli.dv@gmail.com.");
    }
  });
  footer.append("Any problems with the app? Contact me at: ", link);
  return footer;
}
