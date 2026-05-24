/**
 * POST /webhook/hevy — receives workout-save events from Hevy.
 *
 * Notification-only. Never writes to Hevy. Reads workout details,
 * classifies via rules, pushes to ntfy.sh. Synchronous response in
 * <100ms; background work runs in ctx.waitUntil.
 *
 * Auth: Bearer <HEVY_WEBHOOK_TOKEN>, configured at Hevy's developer
 * portal and matched against the Worker secret.
 */

import { Hono } from "hono";
import { classify } from "../lib/classifier.js";
import { HevyClient } from "../lib/client.js";
import { alreadyProcessed } from "../lib/idempotency.js";
import { getUserApiKey } from "../lib/key-storage.js";
import { pushNotification } from "../lib/push.js";

interface Env {
	OAUTH_KV: KVNamespace;
	COOKIE_ENCRYPTION_KEY: string;
	HEVY_WEBHOOK_TOKEN: string;
	NTFY_TOPIC: string;
	COACH_USER_LOGIN: string;
}

const app = new Hono<{ Bindings: Env }>();

/**
 * Constant-time string equality. Prevents timing-attack leakage of
 * the bearer token via response-latency analysis. Returns false fast
 * only on length mismatch (length is not secret); on equal-length
 * inputs, always compares every byte.
 */
function constantTimeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) {
		diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return diff === 0;
}

app.post("/webhook/hevy", async (c) => {
	// 1. Verify bearer token.
	// Hevy's webhook config UI lets the user paste the entire
	// Authorization header value verbatim (e.g., "Bearer abc123" OR
	// just "abc123"). Accept both so a misconfigured prefix doesn't
	// lock us out. Reject hard if the server-side token is empty —
	// otherwise an unset/blank secret would silently accept any
	// caller.
	const token = c.env.HEVY_WEBHOOK_TOKEN;
	if (!token || token.length < 16) {
		console.error("HEVY_WEBHOOK_TOKEN missing or too short — refusing all webhook traffic");
		return c.json({ error: "server_misconfigured" }, 500);
	}
	const auth = c.req.header("Authorization") ?? "";
	const okBare = constantTimeEqual(auth, token);
	const okBearer = constantTimeEqual(auth, `Bearer ${token}`);
	if (!okBare && !okBearer) {
		return c.json({ error: "unauthorized" }, 401);
	}

	// 2. Parse body
	let body: { workoutId?: string };
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "invalid_json" }, 400);
	}
	const workoutId = body.workoutId;
	if (!workoutId) {
		return c.json({ error: "missing_workout_id" }, 400);
	}

	// 3. Idempotency check (mark-as-processed AND return whether seen)
	const seen = await alreadyProcessed(c.env.OAUTH_KV, workoutId);
	if (seen) {
		return c.json({ status: "already_processed", workoutId });
	}

	// 4. Schedule background work, respond 200 immediately
	c.executionCtx.waitUntil(processWorkout(c.env, workoutId));
	return c.json({ status: "accepted", workoutId });
});

/**
 * Background: fetch workout, classify, push notification. All errors
 * are logged but don't propagate — Hevy already got its 200.
 */
async function processWorkout(env: Env, workoutId: string): Promise<void> {
	try {
		// Look up the per-user Hevy API key
		const apiKey = await getUserApiKey(
			env.OAUTH_KV,
			env.COOKIE_ENCRYPTION_KEY,
			env.COACH_USER_LOGIN,
		);
		if (!apiKey) {
			console.error(
				`No Hevy API key in KV for user ${env.COACH_USER_LOGIN} — webhook can't fetch workout`,
			);
			await pushNotification({
				topic: env.NTFY_TOPIC,
				title: "Webhook misconfigured",
				message: `No Hevy API key for ${env.COACH_USER_LOGIN}. Visit /setup to re-link.`,
				priority: 4,
				tags: ["warning"],
			});
			return;
		}

		const client = new HevyClient({ apiKey });

		// Fetch the workout details
		const workout = await client.getWorkout(workoutId);
		if (!workout) {
			console.error(`get_workout returned null for ${workoutId}`);
			return;
		}

		// Classify and push
		const result = await classify(workout, client);
		await pushNotification({
			topic: env.NTFY_TOPIC,
			title: result.title,
			message: result.message,
			tags: result.tags,
			priority: result.classification === "pr" ? 4 : 3,
		});
	} catch (err) {
		console.error("processWorkout failed:", err);
		// Degraded notification so user knows something happened
		try {
			await pushNotification({
				topic: env.NTFY_TOPIC,
				title: "Webhook processing error",
				message: `Workout ${workoutId} received but analysis failed. Check Worker logs.`,
				priority: 4,
				tags: ["warning"],
			});
		} catch {
			// swallow — already in the error path
		}
	}
}

export default app;
