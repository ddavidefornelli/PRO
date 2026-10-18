import { isTauri } from "@tauri-apps/api/core";
import { PlanningClient, type AuthStatus } from "./api";

import { element as node } from "./dom";
import { errorMessage } from "./errors";

const REQUEST_ERROR = "The request could not be completed. Please try again.";
const CODE_LENGTH = 8;

/** A reload at account boundaries discards all views, polls and in-memory data from the old account. */
export async function authenticate(root: HTMLElement, client: PlanningClient): Promise<AuthStatus | null> {
  const loading = node("div", undefined, "startup-loading");
  loading.setAttribute("role", "status");
  loading.setAttribute("aria-label", "Loading PRO");
  const ring = node("span", undefined, "startup-ring");
  ring.setAttribute("aria-hidden", "true");
  loading.append(ring);
  root.replaceChildren(loading);
  if (!isTauri()) {
    root.replaceChildren(node("p", "Open PRO as a desktop app with npm run desktop. The native runtime protects your session credentials."));
    return null;
  }
  // Native permission dialogs have no deadline. Stop animating after a bounded
  // wait, but keep listening: accepting a delayed dialog can still finish startup.
  const startupTimeout = window.setTimeout(() => {
    const stalled = node("section", undefined, "auth-panel");
    const heading = node("h1", "Startup is taking longer than expected");
    const message = node("p", "If macOS is asking for Keychain access, respond to that dialog. PRO will continue automatically when your session is ready. If no dialog is visible, retry the connection.");
    message.setAttribute("role", "status");
    const retry = node("button", "Retry connection");
    retry.type = "button";
    retry.addEventListener("click", () => window.location.reload());
    stalled.append(heading, message, retry);
    root.replaceChildren(stalled);
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
  const distribute = (text: string, start: number): void => {
    const values = text.replace(/\D/g, "").slice(0, CODE_LENGTH);
    if (!values) return;
    const offset = values.length === CODE_LENGTH ? 0 : start;
    for (let i = offset; i < CODE_LENGTH; i++) digits[i]!.value = values[i - offset] ?? "";
    const next = digits[Math.min(offset + values.length, CODE_LENGTH - 1)]!;
    next.focus();
    next.select();
  };
  for (let index = 0; index < CODE_LENGTH; index++) {
    const digit = node("input");
    digit.type = "text";
    digit.inputMode = "numeric";
    digit.autocomplete = index === 0 ? "one-time-code" : "off";
    digit.pattern = "[0-9]";
    digit.setAttribute("aria-label", `Digit ${index + 1} of ${CODE_LENGTH}`);
    digit.addEventListener("focus", () => digit.select());
    digit.addEventListener("paste", (event) => {
      event.preventDefault();
      distribute(event.clipboardData?.getData("text") ?? "", index);
    });
    digit.addEventListener("input", () => {
      const value = digit.value.replace(/\D/g, "");
      if (value.length > 1) distribute(value, index);
      else {
        digit.value = value;
        if (value && index < CODE_LENGTH - 1) digits[index + 1]!.focus();
      }
    });
    digit.addEventListener("keydown", (event) => {
      if (event.key === "Backspace" && !digit.value && index > 0) {
        event.preventDefault();
        digits[index - 1]!.value = "";
        digits[index - 1]!.focus();
      } else if (event.key === "ArrowLeft" && index > 0) {
        event.preventDefault(); digits[index - 1]!.focus();
      } else if (event.key === "ArrowRight" && index < CODE_LENGTH - 1) {
        event.preventDefault(); digits[index + 1]!.focus();
      }
    });
    digits.push(digit);
    codeBoxes.append(digit);
  }
  codeLabel.append(codeBoxes);
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
    if (!form.reportValidity()) return;
    submit.disabled = true;
    resend.disabled = true;
    alert.textContent = "";
    try {
      if (!sent) {
        await client.requestSignInCode(email.value.trim());
        sent = true;
        email.readOnly = true;
        digits.forEach((digit) => { digit.required = true; });
        codeLabel.disabled = false;
        codeLabel.hidden = false;
        resend.hidden = false;
        submit.textContent = "Sign in";
        notice.textContent = "If this address can sign in, a code has been sent. Check your inbox and spam folder.";
        digits[0]!.focus();
      } else {
        await client.verifySignInCode(email.value.trim(), digits.map((digit) => digit.value).join(""));
        window.location.reload();
      }
    } catch (cause) { alert.textContent = errorMessage(cause, REQUEST_ERROR); }
    finally { submit.disabled = false; resend.disabled = false; }
  });
  resend.addEventListener("click", () => {
    sent = false;
    email.readOnly = false;
    digits.forEach((digit) => { digit.value = ""; digit.required = false; });
    codeLabel.disabled = true;
    codeLabel.hidden = true;
    resend.hidden = true;
    submit.textContent = "Send sign-in code";
    notice.textContent = "Wait at least a minute before requesting another code.";
    email.focus();
  });
  form.append(emailLabel, codeLabel, submit, resend);
  section.append(node("h1", "Sign in to PRO"), node("p", "Sign-in requires internet. Your planner syncs to Supabase; a local snapshot and pending changes are also stored on this device, unencrypted in app storage. Attached file contents are never uploaded."), form, notice, alert, reconnect);
  root.replaceChildren(section);
  return null;
}
