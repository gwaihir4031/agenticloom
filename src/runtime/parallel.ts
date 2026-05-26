import { enterParallelContext, exitParallelContext } from '../RollingWindow.js';

/** Run a fixed-length list of zero-arg task thunks concurrently and resolve
 *  with the tuple of their results in declaration order. Tagged with
 *  `enter/exitParallelContext` so any agent the children spawn renders into
 *  the parallel mini layout (header + 3 content rows per slot) instead of
 *  the default 25-row sequential box.
 *
 *  `Promise.all` semantics: rejects on the first task failure. The
 *  `.finally` exits the parallel context on success AND failure so the next
 *  sequential agent always gets the full-size box back. */
export const parallel = <T extends readonly unknown[]>(
  tasks: readonly [...{ [K in keyof T]: () => Promise<T[K]> }],
): Promise<T> => {
  // Signal to RollingWindow that any agent started during this block should
  // use the mini layout (header + 3 content rows at coordinator-assigned
  // absolute row positions) so sibling agents render to distinct row ranges
  // without colliding. Decrement on settle (success OR failure) so the next
  // sequential agent gets the full 25-row box again.
  enterParallelContext();
  return Promise.all(tasks.map((t) => t())).finally(() => {
    exitParallelContext();
  }) as unknown as Promise<T>;
};
