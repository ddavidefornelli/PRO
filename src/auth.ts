import { isTauri } from "@tauri-apps/api/core";
import { PlanningClient, type AuthStatus } from "./api";

import { element as node } from "./dom";
import { errorMessage } from "./errors";
import { supportFooter } from "./support";

const REQUEST_ERROR = "The request could not be completed. Please try again.";
const MIN_CODE_LENGTH = 6;
const MAX_CODE_LENGTH = 10;
const DEFAULT_CODE_LENGTH = 8;

/** A reload at account boundaries discards all views, polls and in-memory data from the old account. */
export async function authenticate(root: HTMLElement, client: PlanningClient): Promise<AuthStatus | null> {
  const loading = node("div", undefined, "startup-loading");
  loading.setAttribute("role", "status");
  loading.setAttribute("aria-label", "Loading prune");
  const ring = node("span", undefined, "startup-ring");
  ring.setAttribute("aria-hidden", "true");
  loading.append(ring);
  root.replaceChildren(loading, supportFooter());
  if (!isTauri()) {
    root.replaceChildren(node("p", "Open prune as a desktop app with npm run desktop. The native runtime protects your session credentials."), supportFooter());
    return null;
  }
  // Native permission dialogs have no deadline. Stop animating after a bounded
  // wait, but keep listening: accepting a delayed dialog can still finish startup.
  const startupTimeout = window.setTimeout(() => {
    const stalled = node("section", undefined, "auth-panel");
    const heading = node("h1", "Startup is taking longer than expected");
    const message = node("p", "If macOS is asking for Keychain access, respond to that dialog. prune will continue automatically when your session is ready. If no dialog is visible, retry the connection.");
    message.setAttribute("role", "status");
    const retry = node("button", "Retry connection");
    retry.type = "button";
    retry.addEventListener("click", () => window.location.reload());
    stalled.append(heading, message, retry);
    root.replaceChildren(stalled, supportFooter());
  }, 30_000);
  let initialError = "";
  try {
    const status = await client.authStatus();
    if (status.email) {
      root.replaceChildren();
      return status;
    }
  } catch (cause) { initialError = errorMessage(cause, REQUEST_ERROR); }
  finally { window.clearTimeout(startupTimeout); }

  const section = node("section", undefined, "auth-panel");
  const form = node("form");
  const emailLabel = node("label", "Email");
  const email = node("input");
  email.type = "email";
  email.autocomplete = "email";
  email.required = true;
  email.maxLength = 254;
  emailLabel.append(email);
  const codeLabel = node("fieldset", undefined, "otp-field");
  codeLabel.append(node("legend", "Code from your email"));
  const codeBoxes = node("div", undefined, "otp-boxes");
  const digits: HTMLInputElement[] = [];
  const resizeCode = (length: number): void => {
    while (digits.length > length) digits.pop()!.remove();
    while (digits.length < length) {
      const digit = makeDigit(digits.length);
      digits.push(digit);
      codeBoxes.append(digit);
    }
    digits.forEach((digit, index) => digit.setAttribute("aria-label", `Digit ${index + 1} of ${length}`));
    codeBoxes.style.setProperty("--code-length", String(length));
  };
  const distribute = (text: string, start: number): void => {
    const values = text.replace(/\D/g, "").slice(0, MAX_CODE_LENGTH);
    if (!values) return;
    const complete = values.length >= MIN_CODE_LENGTH;
    if (complete) resizeCode(values.length);
    else if (start + values.length > digits.length) resizeCode(Math.min(MAX_CODE_LENGTH, start + values.length));
    const offset = complete ? 0 : start;
    for (let i = offset; i < digits.length; i++) digits[i]!.value = values[i - offset] ?? "";
    digits[0]!.setCustomValidity("");
    const next = digits[Math.min(offset + values.length, digits.length - 1)]!;
    next.focus();
    next.select();
  };
  function makeDigit(index: number): HTMLInputElement {
    const digit = node("input");
    digit.type = "text";
    digit.inputMode = "numeric";
    digit.autocomplete = index === 0 ? "one-time-code" : "off";
    digit.pattern = "[0-9]";
    digit.required = index < MIN_CODE_LENGTH;
    digit.addEventListener("focus", () => digit.select());
    digit.addEventListener("paste", (event) => {
      event.preventDefault();
      distribute(event.clipboardData?.getData("text") ?? "", index);
    });
    digit.addEventListener("input", () => {
      digits[0]!.setCustomValidity("");
      const value = digit.value.replace(/\D/g, "");
      if (value.length > 1) distribute(value, index);
      else {
        digit.value = value;
        if (value && index < digits.length - 1) digits[index + 1]!.focus();
      }
    });
    digit.addEventListener("keydown", (event) => {
      digits[0]!.setCustomValidity("");
      if (event.key === "Backspace" && !digit.value && index > 0) {
        event.preventDefault();
        digits[index - 1]!.value = "";
        digits[index - 1]!.focus();
      } else if (event.key === "ArrowLeft" && index > 0) {
        event.preventDefault(); digits[index - 1]!.focus();
      } else if (event.key === "ArrowRight" && index < digits.length - 1) {
        event.preventDefault(); digits[index + 1]!.focus();
      } else if (/^[0-9]$/.test(event.key) && !event.metaKey && !event.ctrlKey && !event.altKey
        && index === digits.length - 1 && digit.value && digit.selectionStart === digit.selectionEnd && digits.length < MAX_CODE_LENGTH) {
        event.preventDefault();
        resizeCode(digits.length + 1);
        digits[index + 1]!.value = event.key;
        digits[index + 1]!.focus();
        digits[index + 1]!.setSelectionRange(1, 1);
      }
    });
    return digit;
  }
  resizeCode(DEFAULT_CODE_LENGTH);
  codeLabel.append(codeBoxes, node("p", "Enter the 6–10 digit code from your email.", "muted"));
  codeLabel.hidden = true;
  codeLabel.disabled = true;
  const submit = node("button", "Send sign-in code");
  submit.type = "submit";
  const resend = node("button", "Use another email / resend code");
  resend.type = "button";
  resend.hidden = true;
  const reconnect = node("button", "Retry connection");
  reconnect.type = "button";
  reconnect.addEventListener("click", () => window.location.reload());
  const alert = node("p", initialError, "error");
  alert.setAttribute("role", "alert");
  const notice = node("p");
  notice.setAttribute("role", "status");
  let sent = false;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const code = digits.map((digit) => digit.value || " ").join("").trimEnd();
    if (sent) digits[0]!.setCustomValidity(/^[0-9]{6,10}$/.test(code) ? "" : "Enter the complete 6–10 digit code without gaps.");
    if (!form.reportValidity()) return;
    submit.disabled = true;
    resend.disabled = true;
    alert.textContent = "";
    try {
      if (!sent) {
        await client.requestSignInCode(email.value.trim());
        sent = true;
        email.readOnly = true;
        digits.forEach((digit, index) => { digit.required = index < MIN_CODE_LENGTH; });
        codeLabel.disabled = false;
        codeLabel.hidden = false;
        resend.hidden = false;
        submit.textContent = "Sign in";
        notice.textContent = "If this address can sign in, a code has been sent. Check your inbox and spam folder.";
        digits[0]!.focus();
      } else {
        await client.verifySignInCode(email.value.trim(), code);
        window.location.reload();
      }
    } catch (cause) { alert.textContent = errorMessage(cause, REQUEST_ERROR); }
    finally { submit.disabled = false; resend.disabled = false; }
  });
  resend.addEventListener("click", () => {
    sent = false;
    email.readOnly = false;
    resizeCode(DEFAULT_CODE_LENGTH);
    digits.forEach((digit) => { digit.value = ""; digit.required = false; digit.setCustomValidity(""); });
    codeLabel.disabled = true;
    codeLabel.hidden = true;
    resend.hidden = true;
    submit.textContent = "Send sign-in code";
    notice.textContent = "Wait at least a minute before requesting another code.";
    email.focus();
  });
  form.append(emailLabel, codeLabel, submit, resend);
  section.append(node("h1", "Sign in to prune"), node("p", "Sign-in requires internet. Your planner syncs to Supabase; a local snapshot and pending changes are also stored on this device, unencrypted in app storage. Attached file contents are never uploaded."), form, notice, alert, reconnect);
  root.replaceChildren(section, supportFooter());
  return null;
}
