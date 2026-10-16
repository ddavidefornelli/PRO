const MIN = 5;
const MAX = 60;
const STEP = 5;
const SWEEP = 300;

/** Relative turning avoids jumping to a new estimate when the knob is grabbed. */
export function estimateDial(initialMinutes = 30, onCommit?: (minutes: number) => void): { element: HTMLElement; minutes: () => number } {
  let minutes = initialMinutes;
  let position = minutes;
  let pointer: number | null = null;
  let previousAngle = 0;
  const wrapper = document.createElement("div");
  wrapper.className = "estimate-control";
  const dial = document.createElement("div");
  dial.className = "estimate-dial";
  dial.tabIndex = 0;
  dial.setAttribute("role", "slider");
  dial.setAttribute("aria-label", "Estimated time in minutes");
  dial.setAttribute("aria-valuemin", String(MIN));
  dial.setAttribute("aria-valuemax", String(MAX));
  dial.title = "Turn to set minutes · 5–60 min · Arrow keys adjust by 5 min";
  const ring = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  ring.setAttribute("viewBox", "0 0 64 64");
  ring.setAttribute("aria-hidden", "true");
  ring.classList.add("estimate-ring");
  const makeCircle = (className: string) => {
    const circle = document.createElementNS(ring.namespaceURI, "circle");
    circle.setAttribute("cx", "32");
    circle.setAttribute("cy", "32");
    circle.setAttribute("r", "30.5");
    circle.setAttribute("pathLength", "60");
    circle.setAttribute("class", className);
    return circle;
  };
  const progress = makeCircle("estimate-ring-progress");
  ring.append(makeCircle("estimate-ring-track"), progress);
  const readout = document.createElement("span");
  readout.className = "dial-readout";
  readout.setAttribute("aria-hidden", "true");
  const value = document.createElement("strong");
  readout.append(value);
  dial.append(ring, readout);
  const update = (snap = true) => {
    minutes = snap ? Math.max(MIN, Math.min(MAX, Math.round(position / STEP) * STEP)) : initialMinutes;
    value.textContent = String(minutes);
    progress.setAttribute("stroke-dasharray", `${minutes} 60`);
    dial.setAttribute("aria-valuenow", String(minutes));
    dial.setAttribute("aria-valuetext", `${minutes} minutes`);
  };
  const angle = (event: PointerEvent) => {
    const rect = dial.getBoundingClientRect();
    return Math.atan2(event.clientY - rect.top - rect.height / 2, event.clientX - rect.left - rect.width / 2) * 180 / Math.PI;
  };
  dial.addEventListener("pointerdown", (event) => {
    if (!event.isPrimary || event.button !== 0 || dial.getAttribute("aria-disabled") === "true") return;
    event.preventDefault();
    dial.focus();
    pointer = event.pointerId;
    previousAngle = angle(event);
    position = minutes;
    dial.setPointerCapture(pointer);
    dial.classList.add("is-turning");
  });
  dial.addEventListener("pointermove", (event) => {
    if (pointer !== event.pointerId) return;
    const next = angle(event);
    const delta = ((next - previousAngle + 540) % 360) - 180;
    previousAngle = next;
    position = Math.max(MIN, Math.min(MAX, position + delta * (MAX - MIN) / SWEEP));
    update();
  });
  let committedMinutes = initialMinutes;
  const commit = () => {
    if (minutes === committedMinutes) return;
    committedMinutes = minutes;
    onCommit?.(minutes);
  };
  const release = () => {
    if (pointer === null) return;
    pointer = null;
    position = minutes;
    dial.classList.remove("is-turning");
    commit();
  };
  dial.addEventListener("pointerup", release);
  dial.addEventListener("pointercancel", release);
  dial.addEventListener("lostpointercapture", release);
  dial.addEventListener("keydown", (event) => {
    if (dial.getAttribute("aria-disabled") === "true") return;
    const adjustments: Record<string, number> = {
      ArrowUp: STEP, ArrowRight: STEP, ArrowDown: -STEP, ArrowLeft: -STEP,
      PageUp: 15, PageDown: -15, Home: MIN - minutes, End: MAX - minutes,
    };
    if (!(event.key in adjustments)) return;
    event.preventDefault();
    position = Math.max(MIN, Math.min(MAX, minutes + adjustments[event.key]));
    update();
    commit();
  });
  update(false);
  wrapper.append(dial);
  return { element: wrapper, minutes: () => minutes };
}
