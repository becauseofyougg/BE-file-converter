/**
 * What a service declares it depends on, for `/health` to actually check —
 * NON-FUNCTIONAL-REQUIREMENTS.md §2.
 *
 * `libs/core` cannot know whether a given service owns a database, talks to the
 * broker or writes to object storage, and it must not import a Prisma client or
 * an S3 SDK to find out. So each app provides its own probes under this token
 * and the shared controller runs whatever it finds.
 *
 * A probe **throws** to report a failure. That is the whole contract: no status
 * enum to get wrong, and any client call that would fail for a real request
 * fails here for the same reason.
 */
export const HEALTH_PROBES = Symbol('HEALTH_PROBES');

export interface HealthProbe {
  /** Appears as the key in the `/health` response. */
  readonly name: string;
  check(): Promise<unknown>;
}

/**
 * A probe has to answer faster than the orchestrator's probe interval, or a
 * slow dependency turns into a *hung* health endpoint — which reads as a dead
 * service and gets the replica killed for the wrong reason.
 */
export const PROBE_TIMEOUT_MS = 3_000;

export async function withProbeTimeout<T>(
  work: Promise<T>,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    // Without this the timer keeps the event loop alive for its full duration
    // on every successful probe, which at a 10-second interval is a process
    // that never idles.
    clearTimeout(timer);
  }
}

/**
 * `SELECT 1` through the same pool the application uses. A driver-level "am I
 * connected" flag would not notice a database that has run out of connections
 * or is refusing queries, which is precisely the state worth catching.
 */
export function databaseProbe(client: {
  $queryRawUnsafe(query: string): Promise<unknown>;
}): HealthProbe {
  return {
    name: 'database',
    check: () => client.$queryRawUnsafe('SELECT 1'),
  };
}
