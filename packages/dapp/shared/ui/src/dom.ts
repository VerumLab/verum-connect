/** An element with its inline style, properties and children in one call; what the
 *  element has no property for (aria-*) becomes an attribute. */

export type Child = Node | string;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  css: string,
  props: Record<string, unknown> = {},
  ...kids: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.style.cssText = css;
  for (const [key, value] of Object.entries(props)) {
    if (key in node) (node as unknown as Record<string, unknown>)[key] = value;
    else node.setAttribute(key, String(value));
  }
  node.append(...kids);
  return node;
}

