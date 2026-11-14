import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, type Mock, test, vi } from "vitest";
import { getEvents } from "../../src/fakturoid/client/event";
import { createExpensePayment } from "../../src/fakturoid/client/expensePayment";
import { searchInvoices } from "../../src/fakturoid/client/invoice";
import {
	GeneralError,
	InvalidDataError,
	request,
	requestAllPages,
	UnexpectedError,
} from "../../src/fakturoid/client/request";
import { getTodos } from "../../src/fakturoid/client/todo";
import { CreateAttachmentSchema } from "../../src/fakturoid/model/common";
import { UpdateExpenseSchema } from "../../src/fakturoid/model/expense";
import { CreateExpensePaymentSchema } from "../../src/fakturoid/model/expensePayment";
import { CreateInventoryMoveSchema, UpdateInventoryMoveSchema } from "../../src/fakturoid/model/inventoryMove";
import { listResult } from "../../src/fakturoid/tool/common";
import { event } from "../../src/fakturoid/tool/event";
import { expense } from "../../src/fakturoid/tool/expense";
import { invoice } from "../../src/fakturoid/tool/invoice";
import { resolveAttachments } from "../../src/staging/resolver";
import { InMemoryFileStaging } from "../../src/staging/storage";
import { createResponse, mockFetch } from "../testUtils/mock";
import { TestStrategy } from "../testUtils/strategy";

const createErrorResponse = (status: number, body: unknown, headers: Record<string, string> = {}): Response => {
	const text = typeof body === "string" ? body : JSON.stringify(body);

	return {
		blob: () => Promise.resolve(new Blob([text])),
		text: () => Promise.resolve(text),
		ok: false,
		status: status,
		headers: new Headers(headers),
	} as Response;
};

type Handler = (input: unknown) => Promise<CallToolResult>;

/** Register tools against a fake server and return the handler of the named tool. */
const captureTool = (
	tools: readonly ((server: never, client: never, staging: never) => void)[],
	name: string,
	client: object,
): Handler => {
	const handlers = new Map<string, Handler>();
	const server = {
		registerTool: (toolName: string, _meta: unknown, handler: Handler) => {
			handlers.set(toolName, handler);
		},
	};

	for (const tool of tools) {
		tool(server as never, client as never, new InMemoryFileStaging() as never);
	}

	const handler = handlers.get(name);
	if (handler == null) {
		throw new Error(`Tool ${name} not registered`);
	}

	return handler;
};

const fullPage = (offset = 0) => Array.from({ length: 40 }, (_, index) => ({ id: offset + index }));

describe("Error handling", () => {
	let mockedFetch: Mock<typeof global.fetch>;

	beforeEach(() => {
		mockedFetch = mockFetch();
	});

	afterEach(() => {
		mockedFetch.mockReset();
	});

	test("422 exposes status and field errors in the message", async () => {
		mockedFetch.mockResolvedValue(createErrorResponse(422, { errors: { name: ["je povinná položka"] } }));

		const error = await request(new TestStrategy(), "/test", "POST", {}).catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(InvalidDataError);
		expect((error as InvalidDataError).status).toBe(422);
		expect((error as Error).message).toContain("HTTP 422");
		expect((error as Error).message).toContain("name: je povinná položka");
	});

	test("General error exposes status and description", async () => {
		mockedFetch.mockResolvedValue(createErrorResponse(403, { error: "forbidden", error_description: "No access" }));

		const error = await request(new TestStrategy(), "/test", "GET").catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(GeneralError);
		expect((error as Error).message).toBe("HTTP 403 forbidden: No access");
	});

	test("Non-JSON error body falls back to UnexpectedError with status", async () => {
		mockedFetch.mockResolvedValue(createErrorResponse(404, "Not Found"));

		const error = await request(new TestStrategy(), "/test", "GET").catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(UnexpectedError);
		expect((error as UnexpectedError).status).toBe(404);
		expect((error as Error).message).toContain("(HTTP 404): Not Found");
	});
});

describe("Retries", () => {
	let mockedFetch: Mock<typeof global.fetch>;

	beforeEach(() => {
		mockedFetch = mockFetch();
		vi.useFakeTimers();
	});

	afterEach(() => {
		mockedFetch.mockReset();
		vi.useRealTimers();
	});

	test("429 is retried for POST and honors X-RateLimit reset", async () => {
		mockedFetch
			.mockResolvedValueOnce(
				createErrorResponse(
					429,
					{ error: "rate_limited", error_description: "Slow down" },
					{ "X-RateLimit": "r=0;t=2" },
				),
			)
			.mockResolvedValueOnce(createResponse({ id: 1 }));

		const promise = request(new TestStrategy(), "/test", "POST", { a: 1 });
		await vi.advanceTimersByTimeAsync(1999);
		expect(mockedFetch).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);

		await expect(promise).resolves.toStrictEqual({ id: 1 });
		expect(mockedFetch).toHaveBeenCalledTimes(2);
	});

	test("503 is retried for GET", async () => {
		mockedFetch
			.mockResolvedValueOnce(createErrorResponse(503, "Maintenance"))
			.mockResolvedValueOnce(createResponse([]));

		const promise = request(new TestStrategy(), "/test", "GET");
		await vi.runAllTimersAsync();

		await expect(promise).resolves.toStrictEqual([]);
		expect(mockedFetch).toHaveBeenCalledTimes(2);
	});

	test("503 is not retried for POST", async () => {
		mockedFetch.mockResolvedValue(createErrorResponse(503, "Maintenance"));

		const promise = request(new TestStrategy(), "/test", "POST", {}).catch((caught: unknown) => caught);
		await vi.runAllTimersAsync();

		expect(await promise).toBeInstanceOf(UnexpectedError);
		expect(mockedFetch).toHaveBeenCalledTimes(1);
	});

	test("Gives up after 3 retries", async () => {
		mockedFetch.mockResolvedValue(createErrorResponse(429, { error: "rate_limited", error_description: "Slow down" }));

		const promise = request(new TestStrategy(), "/test", "GET").catch((caught: unknown) => caught);
		await vi.runAllTimersAsync();

		expect(await promise).toBeInstanceOf(GeneralError);
		expect(mockedFetch).toHaveBeenCalledTimes(4);
	});
});

describe("Pagination", () => {
	let mockedFetch: Mock<typeof global.fetch>;

	beforeEach(() => {
		mockedFetch = mockFetch();
	});

	afterEach(() => {
		mockedFetch.mockReset();
	});

	test("requestAllPages starts at the given page", async () => {
		mockedFetch.mockResolvedValue(createResponse([{ id: 1 }]));

		await requestAllPages(new TestStrategy(), "/test", {}, 1, 3);

		expect(mockedFetch.mock.calls[0]?.[0]).toBe("https://test.example/test?page=3");
	});

	test("Events pass since, subject_id and page limit", async () => {
		mockedFetch.mockResolvedValueOnce(createResponse(fullPage())).mockResolvedValueOnce(createResponse(fullPage(40)));

		const result = await getEvents(new TestStrategy(), "acc", {
			page_count: 1,
			since: "2026-11-01T00:00:00+01:00",
			subject_id: 42,
		});

		expect(result).toHaveLength(40);
		expect(mockedFetch).toHaveBeenCalledTimes(1);
		expect(mockedFetch.mock.calls[0]?.[0]).toBe(
			"https://test.example/accounts/acc/events.json?since=2026-11-01T00%3A00%3A00%2B01%3A00&subject_id=42&page=1",
		);
	});

	test("Todos pass since", async () => {
		mockedFetch.mockResolvedValue(createResponse([]));

		await getTodos(new TestStrategy(), "acc", { since: "2026-11-01" });

		expect(mockedFetch.mock.calls[0]?.[0]).toBe("https://test.example/accounts/acc/todos.json?since=2026-11-01&page=1");
	});

	test("Search passes pagination", async () => {
		mockedFetch.mockResolvedValue(createResponse([]));

		await searchInvoices(new TestStrategy(), "acc", "abc", undefined, { page: 2, page_count: 1 });

		expect(mockedFetch.mock.calls[0]?.[0]).toBe(
			"https://test.example/accounts/acc/invoices/search.json?query=abc&page=2",
		);
	});

	test("listResult flags a possibly truncated list", () => {
		const truncated = listResult(fullPage(), 1, 2);
		const complete = listResult([{ id: 1 }], 1);
		const unlimited = listResult(fullPage());

		expect(truncated.content).toHaveLength(2);
		expect(truncated.content[1]).toMatchObject({ text: expect.stringContaining("request page 3") });
		expect(complete.content).toHaveLength(1);
		expect(unlimited.content).toHaveLength(1);
	});
});

describe("Tool wiring", () => {
	test("fakturoid_get_events forwards filters", async () => {
		const client = { getEvents: vi.fn().mockResolvedValue(fullPage()) };
		const handler = captureTool(event, "fakturoid_get_events", client);

		const result = await handler({ page_count: 1, since: "2026-11-01" });

		expect(client.getEvents).toHaveBeenCalledWith({ page_count: 1, since: "2026-11-01" });
		expect(result.content).toHaveLength(2);
	});

	test("fakturoid_search_invoices forwards pagination", async () => {
		const client = { searchInvoices: vi.fn().mockResolvedValue([]) };
		const handler = captureTool(invoice, "fakturoid_search_invoices", client);

		await handler({ page: 2, page_count: 1, query: "abc" });

		expect(client.searchInvoices).toHaveBeenCalledWith("abc", undefined, { page: 2, page_count: 1 });
	});

	test("fakturoid_update_expense resolves attachments and keeps other fields", async () => {
		const client = { updateExpense: vi.fn().mockResolvedValue({ id: 7 }) };
		const handler = captureTool(expense, "fakturoid_update_expense", client);

		await handler({
			id: 7,
			updateData: {
				attachments: [{ data_url: "data:application/pdf;base64,JVBERi0=" }],
				lines: [{ name: "New line", unit_price: "100" }],
				private_note: "note",
			},
		});

		expect(client.updateExpense).toHaveBeenCalledWith(7, {
			attachments: [{ data_url: "data:application/pdf;base64,JVBERi0=" }],
			lines: [{ name: "New line", unit_price: "100" }],
			private_note: "note",
		});
	});

	test("fakturoid_update_expense without attachments does not send the key", async () => {
		const client = { updateExpense: vi.fn().mockResolvedValue({ id: 7 }) };
		const handler = captureTool(expense, "fakturoid_update_expense", client);

		await handler({ id: 7, updateData: { private_note: "note" } });

		expect(client.updateExpense).toHaveBeenCalledWith(7, { private_note: "note" });
	});
});

describe("Write schemas", () => {
	let mockedFetch: Mock<typeof global.fetch>;

	beforeEach(() => {
		mockedFetch = mockFetch();
	});

	afterEach(() => {
		mockedFetch.mockReset();
	});

	test("paid_on keeps the calendar date as written", () => {
		expect(CreateExpensePaymentSchema.parse({ paid_on: "2026-11-14" }).paid_on).toBe("2026-11-14");
		expect(CreateExpensePaymentSchema.parse({ paid_on: "2026-11-14T00:30:00+01:00" }).paid_on).toBe("2026-11-14");
		expect(CreateExpensePaymentSchema.safeParse({ paid_on: "14.11.2026" }).success).toBe(false);
	});

	test("paid_on is serialized as YYYY-MM-DD in the request body", async () => {
		mockedFetch.mockResolvedValue(createResponse({ id: 1 }));

		const payment = CreateExpensePaymentSchema.parse({ amount: "100", paid_on: "2026-11-14T00:30:00+01:00" });
		await createExpensePayment(new TestStrategy(), "acc", 5, payment);

		expect(JSON.parse(String(mockedFetch.mock.calls[0]?.[1]?.body))).toStrictEqual({
			amount: "100",
			paid_on: "2026-11-14",
		});
	});

	test("moved_on keeps the calendar date as written", () => {
		const created = CreateInventoryMoveSchema.parse({
			direction: "in",
			moved_on: "2026-11-14T00:30:00+01:00",
			purchase_price: 10,
			quantity_change: 1,
		});

		expect(created.moved_on).toBe("2026-11-14");
		expect(UpdateInventoryMoveSchema.parse({ moved_on: "2026-11-14" }).moved_on).toBe("2026-11-14");
	});

	test("Expense update accepts a new line without id", () => {
		const parsed = UpdateExpenseSchema.safeParse({
			lines: [
				{ name: "New", unit_price: "1" },
				{ _destroy: true, id: 3 },
			],
		});

		expect(parsed.success).toBe(true);
	});

	test("Attachment filename has no literal placeholder default", async () => {
		expect(CreateAttachmentSchema.parse({ data_url: "data:application/pdf;base64,JVBERi0=" })).toStrictEqual({
			data_url: "data:application/pdf;base64,JVBERi0=",
		});

		const resolved = await resolveAttachments(
			[
				{ data_url: "data:application/pdf;base64,JVBERi0=" },
				{ data_url: "data:image/png;base64,iVBO", filename: "a.png" },
			],
			new InMemoryFileStaging(),
		);

		expect(resolved?.[0]).not.toHaveProperty("filename");
		expect(resolved?.[1]?.filename).toBe("a.png");
	});
});

describe("Error body without description", () => {
	test("404 resource_not_found becomes GeneralError", async () => {
		const mockedFetch = mockFetch();
		mockedFetch.mockResolvedValue(createErrorResponse(404, { error: "resource_not_found" }));

		const error = await request(new TestStrategy(), "/test", "GET").catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(GeneralError);
		expect((error as Error).message).toBe("HTTP 404 resource_not_found: resource_not_found");
		mockedFetch.mockReset();
	});
});
