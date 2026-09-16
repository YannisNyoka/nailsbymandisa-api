// §7.3 — every admin table that can grow unbounded must paginate from day one. One
// shared slice-and-count helper so that rule can't be quietly skipped on a new list
// endpoint the way it was on a few before this hardening pass added it here.
export function paginate(items, { page = 1, pageSize = 20 } = {}) {
  const start = (page - 1) * pageSize;
  return { items: items.slice(start, start + pageSize), total: items.length, page, pageSize };
}
