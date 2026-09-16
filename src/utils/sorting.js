// Sorts newest-first by createdAt, breaking ties on _id. Two documents can share the
// same createdAt millisecond (e.g. an award immediately followed by an admin
// adjustment) — createdAt alone leaves their relative order undefined. ObjectIds
// generated in sequence within the same process are monotonically increasing even
// within the same millisecond, so comparing them as strings gives a stable, meaningful
// tiebreaker instead of leaving it to sort() implementation details.
export function sortByCreatedAtDesc(docs) {
  return [...docs].sort((a, b) => {
    const byDate = b.createdAt - a.createdAt;
    if (byDate !== 0) return byDate;
    return String(b._id) > String(a._id) ? 1 : -1;
  });
}
