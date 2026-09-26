/**
 * Server-side routine filtering and compact workout summaries.
 *
 * Hevy's /v1/routines endpoint has no folder or title filter and returns
 * the oldest routines first, so finding one week's routines from a client
 * means paging through the whole history (~100 KB per page). These helpers
 * let the MCP tools do that scan inside the Worker and return only what
 * matched, and let get_workouts return a date/title summary without sets.
 */

/** Largest page size Hevy accepts for /v1/routines. */
export const ROUTINE_SCAN_PAGE_SIZE = 10;

/** Pages fetched in parallel while scanning. */
export const ROUTINE_SCAN_CONCURRENCY = 3;

/**
 * Upper bound on pages fetched per filtered call. Each page is one
 * subrequest, and the Workers Free plan allows 50 per invocation. When the
 * history is longer than this, the scan keeps page 1 and the newest pages
 * (Hevy lists oldest first) and reports the skipped range.
 */
export const ROUTINE_SCAN_MAX_PAGES = 40;

/** The fields this module reads; everything else passes through untouched. */
export interface RoutineLike {
	id?: string;
	title?: string;
	folder_id?: number | null;
	exercises?: unknown[];
	[key: string]: unknown;
}

export interface WorkoutLike {
	id: string;
	title?: string | null;
	start_time?: string | null;
	end_time?: string | null;
	exercises?: unknown[];
	[key: string]: unknown;
}

export interface RoutineFilter {
	folderId?: number;
	titleContains?: string;
}

export interface RoutinePage {
	page?: number;
	page_count?: number;
	routines?: RoutineLike[];
}

export interface RoutineScanResult {
	routines: RoutineLike[];
	pagesScanned: number;
	pageCount: number;
	/** Inclusive page range skipped because of ROUTINE_SCAN_MAX_PAGES, if any. */
	skippedPages: { from: number; to: number } | null;
}

export function hasRoutineFilter(filter: RoutineFilter): boolean {
	return filter.folderId !== undefined || filter.titleContains !== undefined;
}

export function routineMatches(
	routine: RoutineLike | undefined,
	filter: RoutineFilter,
): boolean {
	if (
		filter.folderId !== undefined &&
		Number(routine?.folder_id) !== filter.folderId
	) {
		return false;
	}
	if (
		filter.titleContains !== undefined &&
		!String(routine?.title ?? "").includes(filter.titleContains)
	) {
		return false;
	}
	return true;
}

/**
 * Scan every routine page and return the routines that match `filter`,
 * in the order Hevy lists them.
 */
export async function scanRoutines(
	fetchPage: (page: number) => Promise<RoutinePage>,
	filter: RoutineFilter,
	options: { concurrency?: number; maxPages?: number } = {},
): Promise<RoutineScanResult> {
	const concurrency = options.concurrency ?? ROUTINE_SCAN_CONCURRENCY;
	const maxPages = options.maxPages ?? ROUTINE_SCAN_MAX_PAGES;

	const first = await fetchPage(1);
	const pageCount = Math.max(1, first.page_count ?? 1);

	// Page 1 is already fetched. Keep the newest pages when over the cap.
	const remaining: number[] = [];
	let skippedPages: RoutineScanResult["skippedPages"] = null;
	if (pageCount <= maxPages) {
		for (let p = 2; p <= pageCount; p++) remaining.push(p);
	} else {
		const firstKept = pageCount - maxPages + 2;
		skippedPages = { from: 2, to: firstKept - 1 };
		for (let p = firstKept; p <= pageCount; p++) remaining.push(p);
	}

	const pages = new Map<number, RoutineLike[]>([[1, first.routines ?? []]]);
	let cursor = 0;
	const worker = async () => {
		while (cursor < remaining.length) {
			const page = remaining[cursor++];
			const result = await fetchPage(page);
			pages.set(page, result.routines ?? []);
		}
	};
	const workerCount = Math.min(Math.max(1, concurrency), remaining.length);
	await Promise.all(Array.from({ length: workerCount }, worker));

	const routines = [...pages.keys()]
		.sort((a, b) => a - b)
		.flatMap((page) => pages.get(page) ?? [])
		.filter((routine) => routineMatches(routine, filter));

	return { routines, pagesScanned: pages.size, pageCount, skippedPages };
}

/** Per-routine listing lines, shared by the paged and filtered get_routines paths. */
export function formatRoutineDetails(
	routines: RoutineLike[] | undefined,
): string {
	return (
		routines
			?.map((routine, index) => {
				const exerciseCount = routine.exercises?.length || 0;
				return `Routine ${index + 1}: ${routine.title}\n  Exercises: ${exerciseCount}\n  ID: ${routine.id}`;
			})
			.join("\n") || "No routines found"
	);
}

export function describeRoutineFilter(filter: RoutineFilter): string {
	const parts: string[] = [];
	if (filter.folderId !== undefined) parts.push(`folder_id=${filter.folderId}`);
	if (filter.titleContains !== undefined) {
		parts.push(`title_contains=${JSON.stringify(filter.titleContains)}`);
	}
	return parts.join(", ");
}

export function formatRoutineScanHeader(
	result: RoutineScanResult,
	filter: RoutineFilter,
): string {
	const skipped = result.skippedPages
		? `; pages ${result.skippedPages.from}-${result.skippedPages.to} (oldest) skipped by the ${ROUTINE_SCAN_MAX_PAGES}-page cap`
		: "";
	return `Found ${result.routines.length} routines matching ${describeRoutineFilter(filter)} (scanned ${result.pagesScanned} of ${result.pageCount} pages${skipped})`;
}

export interface WorkoutSummary {
	id: string;
	title: string | null;
	start_time: string | null;
	end_time: string | null;
	exercise_count: number;
}

export function summarizeWorkout(workout: WorkoutLike): WorkoutSummary {
	return {
		id: workout.id,
		title: workout.title ?? null,
		start_time: workout.start_time ?? null,
		end_time: workout.end_time ?? null,
		exercise_count: workout.exercises?.length || 0,
	};
}

export function formatWorkoutSummaries(summaries: WorkoutSummary[]): string {
	return (
		summaries
			.map(
				(w, index) =>
					`Workout ${index + 1}: ${w.title || "Untitled"}\n  ID: ${w.id}\n  Start: ${w.start_time}\n  End: ${w.end_time}\n  Exercises: ${w.exercise_count}`,
			)
			.join("\n") || "No workouts found"
	);
}
