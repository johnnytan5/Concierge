/** Menu shape shared by the server (prompt) and browser (tool handlers).
 *  Mirrors orchestrator/inventory.py _to_public() and agent.py menu_for_prompt(). */
export type MenuItem = {
  name: string; category: string | null; price: number | null;
  dietary_tags: string[]; available: boolean; in_stock: boolean;
  /** stock_count as loaded (null = unlimited). Tool handlers keep it private,
   *  like inventory.py's cache; the model only ever sees in_stock. */
  stock?: number | null;
};

export function menuForPrompt(items: MenuItem[]) {
  const lines = [...items]
    .sort((a, b) => (a.category ?? '').localeCompare(b.category ?? '') || a.name.localeCompare(b.name))
    .filter((it) => it.available && it.in_stock)
    .map((it) => {
      const price = it.price ? ` $${Number(it.price).toFixed(2)}` : ' (complimentary)';
      const tags = it.dietary_tags.length ? ` [${it.dietary_tags.join(', ')}]` : '';
      return `- ${it.name} (${it.category})${price}${tags}`;
    });
  return 'MENU (available now):\n' + (lines.join('\n') || '- nothing available');
}
