import policy from "../PRIVACY.md?raw";
import { actionButton, element } from "./dom";

/** Deliberately limited Markdown: headings, paragraphs and lists, never raw HTML. */
function policyContent(): HTMLElement {
  const article = element("article", undefined, "privacy-policy-content");
  article.tabIndex = 0;
  article.setAttribute("aria-label", "Full privacy policy");
  let paragraph: string[] = [];
  let list: HTMLUListElement | null = null;
  const flush = () => {
    if (paragraph.length) article.append(element("p", paragraph.join(" ")));
    paragraph = [];
  };
  for (const line of policy.split(/\r?\n/)) {
    if (line.startsWith("# ")) continue; // The dialog header supplies the title.
    if (!line.trim()) { flush(); list = null; }
    else if (line.startsWith("## ")) { flush(); list = null; article.append(element("h3", line.slice(3))); }
    else if (line.startsWith("- ")) {
      flush();
      if (!list) { list = element("ul"); article.append(list); }
      list.append(element("li", line.slice(2)));
    } else { list = null; paragraph.push(line); }
  }
  flush();
  return article;
}

export function showPrivacyPolicy(opener: HTMLElement | null = null): void {
  if (document.querySelector(".privacy-dialog[open]")) return;
  const dialog = element("dialog", undefined, "privacy-dialog");
  dialog.setAttribute("aria-labelledby", "privacy-policy-title");
  const header = element("header", undefined, "privacy-dialog-header");
  const heading = element("h2", "Privacy Policy");
  heading.id = "privacy-policy-title";
  const close = actionButton("Close privacy policy", () => dialog.close());
  header.append(heading, close);
  dialog.append(header);
  if (policy.includes("[TO COMPLETE:") || /^Status: Draft\b/m.test(policy)) {
    dialog.append(element("p", "Draft policy. Operator details and deployed services still require review before public release.", "privacy-template-warning"));
  }
  dialog.append(policyContent());
  dialog.addEventListener("close", () => {
    dialog.remove();
    if (opener?.isConnected) opener.focus();
  }, { once: true });
  document.body.append(dialog);
  dialog.showModal();
  close.focus();
}

/** Works offline and without native authentication, including during a focus timer. */
export function privacyPolicyButton(label = "Privacy Policy"): HTMLButtonElement {
  const button = actionButton(label, () => showPrivacyPolicy(button));
  button.className = "privacy-policy-button";
  button.setAttribute("aria-haspopup", "dialog");
  return button;
}
