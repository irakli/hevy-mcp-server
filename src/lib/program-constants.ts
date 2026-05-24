/**
 * Personal-trainer program constants.
 *
 * These are referenced by the webhook handler (which has no repo
 * access at runtime) to compute the current cycle/block/week and
 * the target RPE for the day.
 *
 * Update these at the start of each new cycle (~12 weeks apart):
 * - CYCLE_START_DATE: first training day of the current cycle
 * - DAY_PATTERN_FOR_DOW: which session is scheduled per day-of-week
 * - TARGET_RPE_FOR_WEEK: target RPE band per week
 */

// First training day of Cycle 1. Update at cycle boundaries.
export const CYCLE_START_DATE = new Date("2026-05-25T00:00:00Z");

// 0=Sun, 1=Mon, ..., 6=Sat (JavaScript getUTCDay convention)
export type DayPattern = "Upper 1" | "Lower 1" | "Upper 2" | "Lower 2" | "rest";

export const DAY_PATTERN_FOR_DOW: Record<number, DayPattern> = {
	0: "rest", // Sun
	1: "Upper 1", // Mon
	2: "Lower 1", // Tue
	3: "rest", // Wed
	4: "Upper 2", // Thu
	5: "Lower 2", // Fri
	6: "rest", // Sat
};

export interface RPETarget {
	min: number;
	max: number;
}

/**
 * Returns the target RPE band for a given week number (1-indexed from
 * cycle start). Block 1 weeks 1-2 are ramp-up; weeks 3-4 ramp into
 * working weights; Block 2 (weeks 5-8) is hypertrophy intensity;
 * Block 3 (weeks 9-11) is peak strength; week 12 is deload.
 */
export function targetRpeForWeek(weekN: number): RPETarget {
	if (weekN <= 2) return { min: 4, max: 5 }; // Block 1 ramp
	if (weekN <= 4) return { min: 6, max: 7 }; // Block 1 working
	if (weekN <= 8) return { min: 7, max: 8 }; // Block 2 intensity
	if (weekN <= 11) return { min: 8, max: 9 }; // Block 3 peak
	return { min: 6, max: 6 }; // Week 12 deload
}

/**
 * Computes the current week number (1-indexed) from CYCLE_START_DATE.
 * Returns 0 if today is before the cycle start; values >12 mean we've
 * passed the cycle end and need to begin Cycle 2 (constants must be
 * updated for the new cycle).
 */
export function currentWeekNumber(now: Date = new Date()): number {
	const msPerDay = 1000 * 60 * 60 * 24;
	const diffDays = Math.floor(
		(now.getTime() - CYCLE_START_DATE.getTime()) / msPerDay,
	);
	if (diffDays < 0) return 0;
	return Math.floor(diffDays / 7) + 1;
}

/**
 * Returns today's day-pattern based on UTC day-of-week.
 * NOTE: this uses UTC for determinism in the Worker. The user lives
 * in a timezone that may roll over the day boundary differently —
 * acceptable for v1 since the webhook fires shortly after Save and
 * the day-of-week at user's local time is what matters most.
 */
export function todayPattern(now: Date = new Date()): DayPattern {
	return DAY_PATTERN_FOR_DOW[now.getUTCDay()] ?? "rest";
}
