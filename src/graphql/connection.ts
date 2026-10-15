/** GitHub's cursor connections over lists the proxy has read whole. */

export interface Page {
  first?: number;
  last?: number;
  after?: string;
  before?: string;
}

const cursor = (index: number): string => Buffer.from(`cursor:${index}`).toString("base64");

const indexOf = (value: string): number =>
  Number(Buffer.from(value, "base64").toString().replace(/^cursor:/, ""));

/** The `nodes`, `edges`, `pageInfo` and `totalCount` of `items` under `page`. */
export function connection<T>(items: T[], page: Page = {}) {
  let start = 0;
  let end = items.length;
  if (page.after) start = indexOf(page.after) + 1;
  if (page.before) end = Math.min(end, indexOf(page.before));
  if (page.first !== undefined) end = Math.min(end, start + page.first);
  if (page.last !== undefined) start = Math.max(start, end - page.last);
  const nodes = items.slice(start, end);
  return {
    totalCount: items.length,
    nodes,
    edges: nodes.map((node, offset) => ({ node, cursor: cursor(start + offset) })),
    pageInfo: {
      hasNextPage: end < items.length,
      hasPreviousPage: start > 0,
      startCursor: nodes.length ? cursor(start) : null,
      endCursor: nodes.length ? cursor(end - 1) : null,
    },
  };
}
