/** One PhotoKit transaction, shared by concurrent callers. Only identifiers cross
 * the native bridge; deleting media never requires decoding/downloading it. */
export function createTrashDeletion({ getIds, remove, commit, before = async () => null, cancel = async () => {} }) {
  let pending = null;
  return function deleteTrash(idsSnapshot) {
    if (pending) return pending;
    const ids = [...new Set(idsSnapshot || getIds())];
    if (!ids.length) return Promise.resolve(0);
    pending = Promise.resolve().then(async () => {
      const context = await before(ids);
      let nativeSucceeded = false;
      try {
        const success = await remove(ids);
        if (success !== true) { await cancel(context); return 0; }
        nativeSucceeded = true;
        await commit(new Set(ids), context);
        return ids.length;
      } catch (error) {
        // If PhotoKit succeeded but persistence failed, keep the durable journal
        // for reconciliation; never repeat the system deletion automatically.
        if (!nativeSucceeded) await cancel(context);
        throw error;
      }
    }).finally(() => { pending = null; });
    return pending;
  };
}
