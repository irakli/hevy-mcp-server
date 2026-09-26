# MCP Tools Integration Tests

This directory contains comprehensive integration tests for all MCP tools in the Hevy API server.

## Overview

The integration tests verify the end-to-end flow that users will experience when using the MCP tools:
- ✅ **Valid inputs** → successful responses
- ✅ **Invalid inputs** → proper error messages with actionable advice
- ✅ **Edge cases** → appropriate handling (empty arrays, nulls, boundary values)

## Test Structure

Since MCP tools run as Cloudflare Workers Durable Objects, we test the underlying components that power each tool:
1. **Validation** - Input validation (pagination, dates, data structures)
2. **Transformation** - Data transformation from MCP format to API format
3. **API Communication** - HTTP client calls with proper error handling
4. **Error Formatting** - User-friendly error messages

## Test Coverage (50 tests)

### Workout Tools (20 tests)
- ✅ `get_workouts` - Pagination, empty lists, validation errors, API errors, summary mode
- ✅ `get_workout` - Single workout retrieval, 404 handling
- ✅ `create_workout` - Full end-to-end flow with validation, date checks, RPE validation, negative value checks
- ✅ `update_workout` - Update flow, 404 handling
- ✅ `get_workouts_count` - Count retrieval, zero handling
- ✅ `get_workout_events` - Events retrieval, date validation, empty lists

### Routine Tools (10 tests)
- ✅ `get_routines` - List retrieval, empty lists, multi-page folder/title filtering, filter API errors (pure scan logic in `test/lib/routine-query.test.ts`)
- ✅ `get_routine` - Single routine retrieval, 404 handling
- ✅ `create_routine` - Full end-to-end flow, title validation, rep range validation
- ✅ `update_routine` - Update flow, 404 handling

### Exercise Template Tools (8 tests)
- ✅ `get_exercise_templates` - List retrieval, higher page size limits (100)
- ✅ `get_exercise_template` - Single template retrieval, 404 handling
- ✅ `create_exercise_template` - Creation flow, title validation, secondary muscles
- ✅ `get_exercise_history` - History retrieval, date validation, empty lists

### Routine Folder Tools (7 tests)
- ✅ `get_routine_folders` - List retrieval, empty lists
- ✅ `get_routine_folder` - Single folder retrieval, 404 handling
- ✅ `create_routine_folder` - Creation flow

### API Error Handling (5 tests)
- ✅ 401 Unauthorized - Invalid API key
- ✅ 403 Forbidden - Rate limits exceeded
- ✅ 429 Too Many Requests - Rate limiting
- ✅ 500 Internal Server Error - Temporary API issues
- ✅ 503 Service Unavailable - Service downtime

## Running Tests

```bash
# Run integration tests only
npm test -- test/integration/mcp-tools.test.ts

# Run all tests
npm test

# Run with watch mode
npm run test:watch

# Run with coverage
npm run test:coverage

# Run with UI
npm run test:ui
```

## Test Philosophy

### Integration vs Unit Tests
- **Unit Tests** (`test/lib/`) - Test individual functions in isolation
- **Integration Tests** (`test/integration/`) - Test the complete flow from input to output

### Why We Test Components Instead of Durable Objects
Cloudflare Workers Durable Objects use special protocols that aren't easy to test in a Node.js environment. Instead, we test the components that power each tool:
- `HevyClient` - API communication
- Validation functions - Input validation
- Transformation functions - Data transformation
- Error handlers - Error formatting

This approach provides the same confidence that the tools work correctly while being more maintainable and faster to run.

## Validation Coverage

### Pagination Validation
- ✅ Page numbers must be ≥ 1
- ✅ Page size must be within endpoint limits
  - Workouts: max 10
  - Routines: max 10
  - Exercise Templates: max 100
  - Routine Folders: max 10
  - Workout Events: max 10

### Date Validation
- ✅ ISO 8601 format (e.g., `2024-01-15T10:00:00Z`)
- ✅ End time must be after start time
- ✅ Valid date values (not just format)

### Workout Validation
- ✅ At least one exercise required
- ✅ At least one set per exercise required
- ✅ Set type must be valid (`warmup`, `normal`, `failure`, `dropset`)
- ✅ RPE must be one of: 6, 7, 7.5, 8, 8.5, 9, 9.5, 10
- ✅ Numeric values cannot be negative
- ✅ Exercise title and template ID required

### Routine Validation
- ✅ Title required and non-empty
- ✅ At least one exercise required
- ✅ Rep range start ≤ end
- ✅ No negative values

### Exercise Template Validation
- ✅ Title required and non-empty
- ✅ Exercise type required
- ✅ Equipment category required
- ✅ Muscle group required

## Error Message Quality

All error messages include:
1. **What went wrong** - Clear description of the error
2. **Why it happened** - Context about the issue
3. **How to fix** - Actionable steps to resolve the problem

Example:
```
❌ Validation Error

**What went wrong:**
endTime must be after startTime

**How to fix:**
  - Ensure endTime is later than startTime
  - Check for typos in date/time values
  - Verify timezone offsets are correct
```

## Edge Cases Tested

- ✅ Empty arrays (workouts, exercises, sets, routines, templates, folders, events)
- ✅ Null values (notes, descriptions, optional fields)
- ✅ Boundary values (min/max page sizes, date limits)
- ✅ Invalid formats (dates, UUIDs, enums)
- ✅ Negative numbers
- ✅ Out-of-range values (RPE, rep ranges)

## Mocking Strategy

### API Responses
We use `mockFetchSuccess()` and `mockFetchError()` helpers to simulate Hevy API responses:

```typescript
// Success case
mockFetchSuccess({ id: "123", title: "Workout" });

// Error case
mockFetchError(404, "Not Found");
```

### No Real API Calls
All tests run in isolation without making real HTTP requests. This ensures:
- ⚡ Fast test execution
- 🔒 No API key required
- 🎯 Deterministic results
- 💰 No API rate limit consumption

## Contributing

When adding new MCP tools:
1. Add integration tests following the established patterns
2. Test both success and failure cases
3. Include edge cases (empty, null, invalid values)
4. Verify error messages are user-friendly
5. Ensure tests run quickly (< 50ms total)

## Related Files

- `test/lib/client.test.ts` - Unit tests for HevyClient
- `test/lib/transforms.test.ts` - Unit tests for validation functions
- `test/lib/errors.test.ts` - Unit tests for error formatting
- `test/fixtures/workouts.ts` - Test fixtures and mock data
- `test/setup.ts` - Test setup and helper functions

