export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

export function actionButton(text: string, action: () => void | Promise<unknown>, disabled = false): HTMLButtonElement {
  const button = element("button", text);
  button.type = "button";
  button.disabled = disabled;
  button.addEventListener("click", () => { void action(); });
  return button;
}

export function svgElement<K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string>): SVGElementTagNameMap[K] {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  return node;
}

export function decorativeSvg(viewBox: string): SVGSVGElement {
  return svgElement("svg", { viewBox, "aria-hidden": "true", focusable: "false" });
}
