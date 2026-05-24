/**
 * Rules-based classifier for completed Hevy workouts.
 *
 * Given a workout payload (from Hevy's get_workout API) plus per-
 * exercise history (from get_exercise_history), classifies the
 * session into one of: pr, over_rpe, under_rpe, normal. Returns
 * notification copy ready to push.
 *
 * No Claude call. Deterministic. ~50 lines.
 */

import type { HevyClient } from "./client.js";
import {
	currentWeekNumber,
	targetRpeForWeek,
	todayPattern,
} from "./program-constants.js";

export type Classification = "pr" | "over_rpe" | "under_rpe" | "normal";

export interface ClassificationResult {
	classification: Classification;
	title: string;
	message: string;
	tags: string[];
}

interface HevySet {
	type?: string;
	weight_kg?: number | null;
	reps?: number | null;
	rpe?: number | null;
}

interface HevyExercise {
	title?: string;
	exercise_template_id?: string;
	sets?: HevySet[];
}

interface HevyWorkout {
	id: string;
	title?: string;
	exercises?: HevyExercise[];
}

/**
 * Inspect each exercise; for each, decide if it triggered a flag.
 * Priority of classification: pr > over_rpe > under_rpe > normal.
 * Returns the highest-priority flag detected across all exercises.
 */
export async function classify(
	workout: HevyWorkout,
	client: HevyClient,
): Promise<ClassificationResult> {
	const weekN = currentWeekNumber();
	const rpeTarget = targetRpeForWeek(weekN);
	const pattern = todayPattern();

	let pr: {
		lift: string;
		weight: number;
		reps: number;
		prevBest: number;
	} | null = null;
	let highRpe: { lift: string; actual: number; target: string } | null = null;
	let lowRpe: { lift: string; actual: number; target: string } | null = null;

	for (const ex of workout.exercises ?? []) {
		const lift = ex.title ?? "(unknown)";
		const sets = ex.sets ?? [];
		const workingSets = sets.filter((s) => s.type !== "warmup");
		if (workingSets.length === 0) continue;

		// RPE classification (only if RPE was logged on any set)
		const rpeSets = workingSets.filter((s) => typeof s.rpe === "number");
		if (rpeSets.length > 0) {
			const avgRpe =
				rpeSets.reduce((sum, s) => sum + (s.rpe as number), 0) / rpeSets.length;
			if (avgRpe >= rpeTarget.max + 2 && !highRpe) {
				highRpe = {
					lift,
					actual: Math.round(avgRpe * 10) / 10,
					target: `${rpeTarget.min}-${rpeTarget.max}`,
				};
			} else if (avgRpe <= rpeTarget.min - 2 && !lowRpe) {
				lowRpe = {
					lift,
					actual: Math.round(avgRpe * 10) / 10,
					target: `${rpeTarget.min}-${rpeTarget.max}`,
				};
			}
		}

		// PR detection: top weight × reps vs history. Only meaningful for
		// weight_reps-typed exercises (need weight AND reps logged).
		if (ex.exercise_template_id && pr === null) {
			const topSet = workingSets.reduce<HevySet | null>((best, s) => {
				if (typeof s.weight_kg !== "number") return best;
				if (best === null || (s.weight_kg ?? 0) > (best.weight_kg ?? 0))
					return s;
				return best;
			}, null);
			if (
				topSet &&
				typeof topSet.weight_kg === "number" &&
				typeof topSet.reps === "number"
			) {
				try {
					// Pull ~90 days of history for PR comparison
					const startDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
					const history = await client.getExerciseHistory(
						ex.exercise_template_id,
						{ start_date: startDate.toISOString() },
					);
					const prevBest = extractPreviousBest(
						history,
						workout.id,
						topSet.reps,
					);
					if (prevBest !== null && topSet.weight_kg > prevBest) {
						pr = {
							lift,
							weight: topSet.weight_kg,
							reps: topSet.reps,
							prevBest,
						};
					}
				} catch (err) {
					console.warn(`PR check failed for ${lift}:`, err);
				}
			}
		}
	}

	if (pr) {
		return {
			classification: "pr",
			title: "PR!",
			message: `💪 ${pr.lift}: ${pr.weight} kg × ${pr.reps} (prev best ${pr.prevBest} kg)`,
			tags: ["muscle", "trophy"],
		};
	}
	if (highRpe) {
		return {
			classification: "over_rpe",
			title: "Tough session flagged",
			message: `⚠️ ${highRpe.lift} graded RPE ${highRpe.actual} (target ${highRpe.target}). Tomorrow's refinement may cut load.`,
			tags: ["warning"],
		};
	}
	if (lowRpe) {
		return {
			classification: "under_rpe",
			title: "Light session flagged",
			message: `📈 ${lowRpe.lift} graded RPE ${lowRpe.actual} (target ${lowRpe.target}). Tomorrow's refinement may bump load.`,
			tags: ["chart_with_upwards_trend"],
		};
	}
	return {
		classification: "normal",
		title: "Session logged",
		message: `✅ ${workout.title ?? pattern} logged. ${rpeSets(workout) ? "On target." : "(No RPE logged — daily refinement will use rep-completion fallback.)"}`,
		tags: ["white_check_mark"],
	};
}

function rpeSets(workout: HevyWorkout): boolean {
	return (workout.exercises ?? []).some((ex) =>
		(ex.sets ?? []).some((s) => typeof s.rpe === "number"),
	);
}

/**
 * Walks the exercise-history response (paginated workouts) and finds
 * the highest weight previously logged for this exercise at >= the
 * given rep count. Excludes the current workout itself (by id).
 */
function extractPreviousBest(
	history: any,
	currentWorkoutId: string,
	minReps: number,
): number | null {
	// Hevy's getExerciseHistory returns nested workouts containing the
	// exercise; we scan all sets in all workouts excluding current.
	let best: number | null = null;
	const workouts = history?.workouts ?? history?.data ?? [];
	for (const w of workouts) {
		if (w.id === currentWorkoutId) continue;
		for (const ex of w.exercises ?? []) {
			for (const s of ex.sets ?? []) {
				if (
					typeof s.weight_kg === "number" &&
					typeof s.reps === "number" &&
					s.reps >= minReps
				) {
					if (best === null || s.weight_kg > best) best = s.weight_kg;
				}
			}
		}
	}
	return best;
}
