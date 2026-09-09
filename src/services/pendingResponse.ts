/** Keep a prompt until the core acknowledges it. Lock by prompt ID so rapid
 * clicks cannot send two different decisions while a request is in flight. */
export async function acknowledgePrompt(
  pending: Set<string>,
  id: string,
  send: () => Promise<unknown>,
  remove: (id: string) => void,
): Promise<boolean> {
  if (pending.has(id)) return false;
  pending.add(id);
  try {
    // The context guard uses null for failure; successful void calls return undefined.
    if (await send() === null) return false;
    remove(id);
    return true;
  } finally {
    pending.delete(id);
  }
}
