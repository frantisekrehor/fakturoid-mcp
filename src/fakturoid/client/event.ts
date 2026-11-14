import type { AuthenticationStrategy } from "../../auth/strategy.js";
import type { Event, GetEventsFilters } from "../model/event.js";
import { requestAllPages } from "./request.js";

/**
 * Get all events.
 *
 * @see https://www.fakturoid.cz/api/v3/events#events-index
 *
 * @param configuration
 * @param accountSlug
 *
 * @returns List of all events.
 */
const getEvents = async (
	strategy: AuthenticationStrategy,
	accountSlug: string,
	filters?: GetEventsFilters,
): Promise<Event[] | Error> => {
	const queryParams = Object.fromEntries(
		[
			["since", filters?.since],
			["subject_id", filters?.subject_id?.toString()],
		].filter((value): value is [string, string] => value[1] != null),
	);

	return await requestAllPages(
		strategy,
		`/accounts/${accountSlug}/events.json`,
		queryParams,
		filters?.page_count,
		filters?.page,
	);
};

export { getEvents };
