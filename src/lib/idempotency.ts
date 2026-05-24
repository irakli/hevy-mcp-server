/**
 * KV-based idempotency check for webhook events.
 *
 * Hevy retries on 5xx and on timeout (>5s response). Without dedupe,
 * a slow first attempt could process the same workout twice — once
 * for the slow original, again for the retry. This module records
 * processed workoutIds in KV with a 24h TTL.
 *
 * Pattern: call alreadyProcessed() at the top of the handler. If
 * true, short-circuit. If false, the call ALSO marks the workoutId
 * as processed (set-if-not-exists semantics simulated here since
 * KV doesn't natively support it).
 */

const PREFIX = "webhook:processed:";
const TTL_SECONDS = 24 * 60 * 60;

/**
 * Checks whether the given workoutId has been processed in the last
 * 24 hours. If not, marks it as processed and returns false. If yes,
 * returns true (caller should short-circuit).
 *
 * Race-conditioning two concurrent webhooks for the same workoutId
 * would let both pass the check (KV is eventually consistent). For
 * our use case (one user, ≤1 workout/hour) this is not a real risk.
 */
export async function alreadyProcessed(
	kv: KVNamespace,
	workoutId: string,
): Promise<boolean> {
	const key = `${PREFIX}${workoutId}`;
	const existing = await kv.get(key);
	if (existing !== null) {
		return true;
	}
	await kv.put(key, "1", { expirationTtl: TTL_SECONDS });
	return false;
}
