export function page<T extends Record<string, unknown>>(rows: T[], limit = 50) {
  return {
    items: rows.slice(0, limit),
    nextCursor:
      rows.length > limit ? String(rows[limit - 1]?.id ?? rows[limit - 1]?.productId) : null,
  };
}
