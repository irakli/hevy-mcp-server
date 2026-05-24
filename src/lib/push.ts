/**
 * ntfy.sh sender — a single POST to https://ntfy.sh/<topic>.
 *
 * ntfy.sh is a free, no-account push notification service. The user
 * subscribes to a topic in the iOS/Android app; we publish to it.
 * Topic is the shared secret (anyone who guesses it can spam you);
 * we use a long random string to mitigate.
 *
 * Failures are logged but not surfaced — a missed push is acceptable
 * (Hevy retries the underlying webhook if we 5xx, but our handler
 * returns 200 immediately and runs the push in ctx.waitUntil, so a
 * push failure won't trigger a retry).
 */

export interface PushOptions {
	/** Topic to publish to (from NTFY_TOPIC env). */
	topic: string;
	/** Message body. Plain text. */
	message: string;
	/** Optional title (shown bold in the notification). */
	title?: string;
	/** Optional priority (1=min, 5=urgent). Default 3. */
	priority?: number;
	/** Optional tags (emoji shortcodes or words). */
	tags?: string[];
	/** Optional click-through URL (e.g., a deeplink to Claude.ai). */
	click?: string;
}

export async function pushNotification(opts: PushOptions): Promise<void> {
	const url = `https://ntfy.sh/${encodeURIComponent(opts.topic)}`;
	const headers: Record<string, string> = {
		"Content-Type": "text/plain; charset=utf-8",
	};
	if (opts.title) headers["Title"] = opts.title;
	if (opts.priority) headers["Priority"] = String(opts.priority);
	if (opts.tags && opts.tags.length > 0) headers["Tags"] = opts.tags.join(",");
	if (opts.click) headers["Click"] = opts.click;

	try {
		const res = await fetch(url, {
			method: "POST",
			headers,
			body: opts.message,
		});
		if (!res.ok) {
			console.error(
				`ntfy push failed: ${res.status} ${res.statusText} (topic: ${opts.topic})`,
			);
		}
	} catch (err) {
		console.error("ntfy push threw:", err);
	}
}
