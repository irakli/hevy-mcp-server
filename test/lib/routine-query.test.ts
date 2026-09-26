import { describe, it, expect } from "vitest";
import {
	ROUTINE_SCAN_MAX_PAGES,
	describeRoutineFilter,
	formatRoutineDetails,
	formatRoutineScanHeader,
	formatWorkoutSummaries,
	hasRoutineFilter,
	routineMatches,
	scanRoutines,
	summarizeWorkout,
	type RoutineLike,
	type RoutinePage,
} from "../../src/lib/routine-query.js";

function routine(
	id: string,
	title: string,
	folderId: number | null,
	exerciseCount = 0,
) {
	return {
		id,
		title,
		folder_id: folderId,
		exercises: Array.from({ length: exerciseCount }, (_, i) => ({ index: i })),
	};
}

/** Fake fetchPage over an in-memory page list, recording call order and concurrency. */
function fakePages(
	pages: RoutineLike[][],
	opts: { omitPageCount?: boolean } = {},
) {
	const calls: number[] = [];
	let inFlight = 0;
	let maxInFlight = 0;
	const fetchPage = async (page: number): Promise<RoutinePage> => {
		calls.push(page);
		inFlight++;
		maxInFlight = Math.max(maxInFlight, inFlight);
		await new Promise((resolve) => setTimeout(resolve, 1));
		inFlight--;
		return {
			page,
			...(opts.omitPageCount ? {} : { page_count: pages.length }),
			routines: pages[page - 1] ?? [],
		};
	};
	return { fetchPage, calls, maxInFlight: () => maxInFlight };
}

describe("hasRoutineFilter", () => {
	it("is false with no filter and true with either field", () => {
		expect(hasRoutineFilter({})).toBe(false);
		expect(hasRoutineFilter({ folderId: 1 })).toBe(true);
		expect(hasRoutineFilter({ titleContains: "Upper" })).toBe(true);
	});
});

describe("routineMatches", () => {
	const r = routine("a", "Upper 1 — Horizontal Emphasis", 3695687);

	it("matches on folder_id", () => {
		expect(routineMatches(r, { folderId: 3695687 })).toBe(true);
		expect(routineMatches(r, { folderId: 3636987 })).toBe(false);
	});

	it("matches title as a case-sensitive substring", () => {
		expect(routineMatches(r, { titleContains: "Upper 1" })).toBe(true);
		expect(routineMatches(r, { titleContains: "upper 1" })).toBe(false);
	});

	it("requires both when both are given", () => {
		expect(
			routineMatches(r, { folderId: 3695687, titleContains: "Upper 1" }),
		).toBe(true);
		expect(
			routineMatches(r, { folderId: 3695687, titleContains: "Lower 1" }),
		).toBe(false);
		expect(routineMatches(r, { folderId: 1, titleContains: "Upper 1" })).toBe(
			false,
		);
	});

	it("tolerates routines without a folder or title", () => {
		expect(routineMatches({ id: "x" }, { folderId: 5 })).toBe(false);
		expect(routineMatches({ id: "x" }, { titleContains: "Upper" })).toBe(false);
	});
});

describe("scanRoutines", () => {
	const pages = [
		[routine("old-u1", "Upper 1", 100), routine("old-l1", "Lower 1", 100)],
		[
			routine("w4-u1", "Upper 1", 400),
			routine("w4-sit", "Conditioning - SIT (Air Bike)", 400),
		],
		[routine("w5-u1", "Upper 1", 500, 13), routine("w5-l1", "Lower 1", 500, 6)],
		[routine("w5-u2", "Upper 2", 500, 13), routine("w5-l2", "Lower 2", 500, 6)],
	];

	it("filters by folder across multiple pages, preserving page order", async () => {
		const fake = fakePages(pages);
		const result = await scanRoutines(fake.fetchPage, { folderId: 500 });

		expect(result.routines.map((r) => r.id)).toEqual([
			"w5-u1",
			"w5-l1",
			"w5-u2",
			"w5-l2",
		]);
		expect(result.pagesScanned).toBe(4);
		expect(result.pageCount).toBe(4);
		expect(result.skippedPages).toBeNull();
		expect(fake.calls[0]).toBe(1);
		expect([...fake.calls].sort()).toEqual([1, 2, 3, 4]);
	});

	it("filters by title across pages", async () => {
		const result = await scanRoutines(fakePages(pages).fetchPage, {
			titleContains: "Upper 1",
		});
		expect(result.routines.map((r) => r.id)).toEqual([
			"old-u1",
			"w4-u1",
			"w5-u1",
		]);
	});

	it("combines folder and title filters", async () => {
		const result = await scanRoutines(fakePages(pages).fetchPage, {
			folderId: 500,
			titleContains: "Lower",
		});
		expect(result.routines.map((r) => r.id)).toEqual(["w5-l1", "w5-l2"]);
	});

	it("returns an empty list when nothing matches", async () => {
		const result = await scanRoutines(fakePages(pages).fetchPage, {
			folderId: 999,
		});
		expect(result.routines).toEqual([]);
		expect(result.pagesScanned).toBe(4);
		expect(formatRoutineDetails(result.routines)).toBe("No routines found");
		expect(formatRoutineScanHeader(result, { folderId: 999 })).toBe(
			"Found 0 routines matching folder_id=999 (scanned 4 of 4 pages)",
		);
	});

	it("never has more than the configured number of pages in flight", async () => {
		const many = Array.from({ length: 12 }, (_, i) => [
			routine(`r${i}`, "Upper 1", i),
		]);
		const fake = fakePages(many);
		const result = await scanRoutines(
			fake.fetchPage,
			{ titleContains: "Upper" },
			{ concurrency: 3 },
		);

		expect(result.routines).toHaveLength(12);
		expect(fake.maxInFlight()).toBeLessThanOrEqual(3);
		expect(fake.calls).toHaveLength(12);
	});

	it("treats a missing page_count as a single page", async () => {
		const fake = fakePages(pages, { omitPageCount: true });
		const result = await scanRoutines(fake.fetchPage, { folderId: 100 });

		expect(fake.calls).toEqual([1]);
		expect(result.pageCount).toBe(1);
		expect(result.routines.map((r) => r.id)).toEqual(["old-u1", "old-l1"]);
	});

	it("keeps page 1 and the newest pages when over the page cap", async () => {
		const total = ROUTINE_SCAN_MAX_PAGES + 10;
		const many = Array.from({ length: total }, (_, i) => [
			routine(`p${i + 1}`, "Upper 1", i + 1),
		]);
		const fake = fakePages(many);
		const result = await scanRoutines(fake.fetchPage, { folderId: total });

		expect(result.pagesScanned).toBe(ROUTINE_SCAN_MAX_PAGES);
		expect(result.skippedPages).toEqual({ from: 2, to: 11 });
		expect(result.routines.map((r) => r.id)).toEqual([`p${total}`]);
		expect(fake.calls).not.toContain(2);
		expect(fake.calls).not.toContain(11);
		expect(fake.calls).toContain(12);
		expect(formatRoutineScanHeader(result, { folderId: total })).toContain(
			`pages 2-11 (oldest) skipped by the ${ROUTINE_SCAN_MAX_PAGES}-page cap`,
		);
	});

	it("propagates a page fetch failure", async () => {
		const failing = async (page: number): Promise<RoutinePage> => {
			if (page === 3) throw new Error("boom");
			return { page, page_count: 4, routines: [] };
		};
		await expect(scanRoutines(failing, { folderId: 1 })).rejects.toThrow(
			"boom",
		);
	});
});

describe("formatRoutineDetails (unfiltered get_routines output)", () => {
	it("matches the legacy per-routine listing format byte for byte", () => {
		const routines = [
			routine("r1", "Push Day", 1, 3),
			routine("r2", "Pull Day", 1),
		];
		const legacy = routines
			.map((r, index) => {
				const exerciseCount = r.exercises?.length || 0;
				return `Routine ${index + 1}: ${r.title}\n  Exercises: ${exerciseCount}\n  ID: ${r.id}`;
			})
			.join("\n");

		expect(formatRoutineDetails(routines)).toBe(legacy);
		expect(formatRoutineDetails(routines)).toBe(
			"Routine 1: Push Day\n  Exercises: 3\n  ID: r1\nRoutine 2: Pull Day\n  Exercises: 0\n  ID: r2",
		);
	});

	it("falls back to 'No routines found' for empty or missing lists", () => {
		expect(formatRoutineDetails([])).toBe("No routines found");
		expect(formatRoutineDetails(undefined)).toBe("No routines found");
	});
});

describe("describeRoutineFilter", () => {
	it("names every active filter", () => {
		expect(
			describeRoutineFilter({ folderId: 3695687, titleContains: "Upper 1" }),
		).toBe('folder_id=3695687, title_contains="Upper 1"');
	});
});

describe("workout summaries", () => {
	const workout = {
		id: "w1",
		title: "Upper 1 — Horizontal Emphasis",
		start_time: "2026-09-23T10:53:53+00:00",
		end_time: "2026-09-23T12:01:10+00:00",
		exercises: [
			{ title: "Bench Press (Barbell)", sets: [{ weight_kg: 55, reps: 10 }] },
			{ title: "Face Pull", sets: [{ weight_kg: 7.5, reps: 15 }] },
		],
	};

	it("keeps only id, title, times, and exercise count", () => {
		const summary = summarizeWorkout(workout);
		expect(summary).toEqual({
			id: "w1",
			title: "Upper 1 — Horizontal Emphasis",
			start_time: "2026-09-23T10:53:53+00:00",
			end_time: "2026-09-23T12:01:10+00:00",
			exercise_count: 2,
		});
		expect(JSON.stringify(summary)).not.toContain("sets");
	});

	it("tolerates missing fields", () => {
		expect(summarizeWorkout({ id: "w2" })).toEqual({
			id: "w2",
			title: null,
			start_time: null,
			end_time: null,
			exercise_count: 0,
		});
	});

	it("formats one block per workout", () => {
		expect(formatWorkoutSummaries([summarizeWorkout(workout)])).toBe(
			"Workout 1: Upper 1 — Horizontal Emphasis\n  ID: w1\n  Start: 2026-09-23T10:53:53+00:00\n  End: 2026-09-23T12:01:10+00:00\n  Exercises: 2",
		);
		expect(formatWorkoutSummaries([])).toBe("No workouts found");
	});
});
