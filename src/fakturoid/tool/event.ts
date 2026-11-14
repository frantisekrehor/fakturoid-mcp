import { GetEventsFiltersSchema } from "../model/event.js";
import { createTool, listResult, type ServerToolCreator } from "./common.js";

const getEvents = createTool(
	"fakturoid_get_events",
	"Get Events",
	"Retrieve a list of events (audit trail) showing activities and changes in the account. The full history can be very long: use since, subject_id or page_count (40 items per page) to narrow it.",
	async (client, filters) => {
		const events = await client.getEvents(filters);

		return listResult(events, filters.page_count, filters.page);
	},
	GetEventsFiltersSchema.shape,
);

const event = [getEvents] as const satisfies ServerToolCreator[];

export { event };
