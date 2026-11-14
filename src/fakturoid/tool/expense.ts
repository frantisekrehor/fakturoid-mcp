import { z } from "zod/v3";
import { CreateAttachmentToolSchema, PaginationSchema } from "../model/common.js";
import { CreateExpenseSchema, GetExpenseFiltersSchema, UpdateExpenseSchema } from "../model/expense.js";
import { resolveAttachments } from "../../staging/resolver.js";
import { createTool, listResult, type ServerToolCreator } from "./common.js";

const getExpenses = createTool(
	"fakturoid_get_expenses",
	"Get Expenses",
	"Retrieve a list of expenses with optional filtering by status, date range, supplier, and other criteria. Returns all pages by default; use page/page_count (40 items per page) to limit large results.",
	async (client, { filters }) => {
		const expenses = await client.getExpenses(filters);

		return listResult(expenses, filters?.page_count, filters?.page);
	},
	{
		filters: GetExpenseFiltersSchema.optional(),
	},
);

const searchExpenses = createTool(
	"fakturoid_search_expenses",
	"Search Expenses",
	"Search expenses by text query and optionally filter by tags. Returns all pages by default; use page/page_count (40 items per page) to limit large results.",
	async (client, { query, tags, page, page_count }) => {
		const expenses = await client.searchExpenses(query, tags, { page: page, page_count: page_count });

		return listResult(expenses, page_count, page);
	},
	{
		accountSlug: z.string().min(1),
		query: z.string().optional(),
		tags: z.array(z.string()).optional(),
		...PaginationSchema.shape,
	},
);

const getExpenseDetail = createTool(
	"fakturoid_get_expense_detail",
	"Get Expense Detail",
	"Retrieve detailed information about a specific expense by its ID",
	async (client, { id }) => {
		const expense = await client.getExpenseDetail(id);

		return {
			content: [{ text: JSON.stringify(expense, null, 2), type: "text" }],
		};
	},
	{
		accountSlug: z.string().min(1),
		id: z.number(),
	},
);

const downloadExpenseAttachment = createTool(
	"fakturoid_download_expense_attachment",
	"Download Expense Attachment",
	"Download a specific attachment from an expense. Returns a file reference that can be opened via /download/:ref",
	async (client, { expenseId, attachmentId }, staging) => {
		const attachment = await client.downloadExpenseAttachment(expenseId, attachmentId);

		if (attachment instanceof Blob) {
			const buffer = await attachment.arrayBuffer();
			const ref = await staging.store({
				content: buffer,
				filename: `expense-${expenseId}-attachment-${attachmentId}`,
				mimeType: attachment.type || "application/octet-stream",
			});
			const sizeKB = (buffer.byteLength / 1024).toFixed(1);

			return {
				content: [
					{
						text: `File downloaded successfully. File ref: ${ref} (expires in 5 minutes). Size: ${sizeKB} KB. Open in browser: /download/${ref}`,
						type: "text" as const,
					},
				],
			};
		}

		return {
			content: [{ text: `Error downloading file: ${String(attachment)}`, type: "text" as const }],
			isError: true,
		};
	},
	{
		attachmentId: z.number(),
		expenseId: z.number(),
	},
);

const fireExpenseAction = createTool(
	"fakturoid_fire_expense_action",
	"Fire Expense Action",
	"Execute actions on an expense such as locking or unlocking",
	async (client, { id, event }) => {
		const result = await client.fireExpenseAction(id, event);

		return {
			content: [{ text: JSON.stringify(result, null, 2), type: "text" }],
		};
	},
	{
		accountSlug: z.string().min(1),
		event: z.enum(["lock", "unlock"]),
		id: z.number(),
	},
);

const createExpense = createTool(
	"fakturoid_create_expense",
	"Create Expense",
	"Low-level expense creation. Prefer fakturoid_smart_create_expense which handles subject resolution and duplicate detection automatically. Use this only when you already have the subject_id and need direct control. For attachments, provide file_ref (from /upload page - preferred), source_url, file_path, or data_url.",
	async (client, expenseData, staging) => {
		const resolvedAttachments = await resolveAttachments(expenseData.attachments, staging);

		const expense = await client.createExpense({
			...expenseData,
			attachments: resolvedAttachments,
		});

		return {
			content: [{ text: JSON.stringify(expense, null, 2), type: "text" }],
		};
	},
	{
		...CreateExpenseSchema.shape,
		attachments: z.array(CreateAttachmentToolSchema).optional(),
	},
);

const updateExpense = createTool(
	"fakturoid_update_expense",
	"Update Expense",
	"Update an existing expense with new data. Lines without id are added, lines with id are updated (or deleted with _destroy). For attachments, provide file_ref (from /upload page - preferred), source_url, file_path, or data_url.",
	async (client, { id, updateData }, staging) => {
		const { attachments, ...rest } = updateData;
		const resolvedAttachments = await resolveAttachments(attachments, staging);

		const expense = await client.updateExpense(id, {
			...rest,
			...(resolvedAttachments != null && { attachments: resolvedAttachments }),
		});

		return {
			content: [{ text: JSON.stringify(expense, null, 2), type: "text" }],
		};
	},
	{
		id: z.number(),
		updateData: UpdateExpenseSchema.extend({
			attachments: z.array(CreateAttachmentToolSchema).optional(),
		}),
	},
);

const deleteExpense = createTool(
	"fakturoid_delete_expense",
	"Delete Expense",
	"Delete an expense by its ID",
	async (client, { id }) => {
		await client.deleteExpense(id);

		return {
			content: [{ text: "Expense deleted successfully", type: "text" }],
		};
	},
	{
		id: z.number(),
	},
);

const expense = [
	getExpenses,
	searchExpenses,
	getExpenseDetail,
	downloadExpenseAttachment,
	fireExpenseAction,
	createExpense,
	updateExpense,
	deleteExpense,
] as const satisfies ServerToolCreator[];

export { expense };
