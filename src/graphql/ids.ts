/**
 * Global node IDs: the type and the Gitea coordinates of the object, so a
 * mutation given an ID can find it again without any state on the proxy.
 */

export interface NodeRef {
  type: string;
  repo: string;
  key: string;
}

export const nodeId = (type: string, repo: string, key: string | number): string =>
  Buffer.from(`${type}:${repo}:${key}`).toString("base64url");

export function decodeId(id: string): NodeRef {
  const [type = "", repo = "", ...rest] = Buffer.from(id, "base64url").toString().split(":");
  return { type, repo, key: rest.join(":") };
}
