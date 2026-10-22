import { actionButton, element } from "./dom";
import { acknowledgePrivacy, hasPrivacyAcknowledgement, PRIVACY_POLICY_VERSION } from "./privacy-state";
import { privacyPolicyButton } from "./privacy";
import { supportFooter } from "./support";

/** Must finish before authentication, credential restoration, queue replay or AI checks. */
export async function requirePrivacyAcknowledgement(root: HTMLElement): Promise<void> {
  try {
    if (hasPrivacyAcknowledgement(window.localStorage)) return;
  } catch { /* Some runtimes deny even access to localStorage. Show a recoverable gate. */ }

  await new Promise<void>((resolve) => {
    const render = (deferred = false): void => {
      const panel = element("section", undefined, "privacy-onboarding");
      panel.setAttribute("aria-labelledby", "privacy-onboarding-title");
      const title = element("h1", deferred ? "You have not continued" : "Privacy & agreements");
      title.id = "privacy-onboarding-title";
      title.tabIndex = -1;
      panel.append(title);
      if (deferred) {
        panel.append(element("p", "prune has not restored your session, contacted the planner service or enabled AI. You can close the app, read the Privacy Policy, or return when you are ready."),
          privacyPolicyButton("Read Privacy Policy"), actionButton("Back to privacy notice", () => render()));
      } else {
        panel.append(element("p", "Please review how prune handles your data before signing in or restoring a session."));
        const summary = element("ul", undefined, "privacy-summary");
        for (const text of [
          "Your email, planner and resource metadata sync through Supabase. File contents are not uploaded.",
          "An unencrypted planner cache and pending changes stay on this device after sign-out. Session credentials use the OS credential store.",
          "Weekly AI is optional and off by default for new accounts. Sending selected activity to OpenAI needs a separate opt-in. Continuing here does not change your AI preference.",
        ]) summary.append(element("li", text));
        panel.append(summary, privacyPolicyButton("Read Privacy Policy"));
        const form = element("form", undefined, "privacy-agreements");
        const label = element("label", undefined, "privacy-acknowledgement");
        const checkbox = element("input");
        checkbox.type = "checkbox";
        checkbox.required = true;
        checkbox.checked = false;
        const wording = element("span", "I have read the Privacy Policy.");
        label.append(checkbox, wording);
        const explanation = element("p", "This acknowledges the notice, not AI consent or a waiver of your rights. Saved only on this device.", "muted");
        explanation.id = "privacy-acknowledgement-explanation";
        checkbox.setAttribute("aria-describedby", explanation.id);
        const error = element("p", "", "error");
        error.setAttribute("role", "alert");
        const actions = element("div", undefined, "privacy-actions");
        const proceed = element("button", "Continue to prune");
        proceed.type = "submit";
        proceed.disabled = true;
        checkbox.addEventListener("change", () => { proceed.disabled = !checkbox.checked; });
        actions.append(proceed, actionButton("Not now", () => render(true)));
        form.addEventListener("submit", (event) => {
          event.preventDefault();
          if (!checkbox.checked || !form.reportValidity()) return;
          try { acknowledgePrivacy(window.localStorage); }
          catch {
            error.textContent = "Could not save your privacy acknowledgement on this device. Allow app storage and try again. prune has not connected to your account.";
            return;
          }
          root.replaceChildren();
          resolve();
        });
        form.append(label, explanation, error, actions);
        panel.append(form, element("p", `Notice version: ${PRIVACY_POLICY_VERSION}`, "muted"));
      }
      root.replaceChildren(panel, supportFooter());
      title.focus();
    };
    render();
  });
}
