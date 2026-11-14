import { z } from "zod/v3";
import { PaginationSchema } from "./common.js";

const TodoSchema = z.object({
	/** Date and time of todo completion */
	completed_at: z.coerce.date().nullable(),

	/** Date and time of todo creation */
	created_at: z.coerce.date(),
	/** Unique identifier in Fakturoid */
	id: z.number().int(),

	/** Todo name */
	name: z.string(),

	/** Parameters with details about todo, specific for each type of todo */
	params: z.record(z.string(), z.unknown()),

	/** Attributes of objects related to the todo */
	related_objects: z.array(
		z.object({
			/** ID of the object related to todo */
			id: z.number().int(),
			/** Type of the object related to the todo */
			type: z.enum(["Invoice", "Subject", "Expense", "Generator", "RecurringGenerator", "ExpenseGenerator"]),
		}),
	),

	/** Todo text */
	text: z.string(),
});

type Todo = z.infer<typeof TodoSchema>;

const GetTodosFiltersSchema = z
	.object({
		/** Only todos created after this date and time (ISO 8601) */
		since: z.string().describe("Only items created after this date and time (ISO 8601)"),
	})
	.partial()
	.merge(PaginationSchema);

type GetTodosFilters = z.infer<typeof GetTodosFiltersSchema>;

export { TodoSchema, GetTodosFiltersSchema };
export type { Todo, GetTodosFilters };
