/**
 * Attributes that give an element the workbench's shared tooltip, shown on hover and keyboard focus
 * by `ReviewTooltips`. One listener serves every element, so a grid of cells stays cheap.
 */
export function tip(text: string, title?: string) {
  if (title === undefined) return { "data-tip": text, "aria-description": text };

  return { "data-tip": text, "data-tip-title": title, "aria-description": `${title}. ${text}` };
}
