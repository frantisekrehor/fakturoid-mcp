import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, type Mock, test, vi } from "vitest";
import { getInvoices } from "../../src/fakturoid/client/invoice";
import { GeneralError, request } from "../../src/fakturoid/client/request";
import { DateStringSchema } from "../../src/fakturoid/model/common";
import { UpdateExpenseSchema } from "../../src/fakturoid/model/expense";
import { listResult } from "../../src/fakturoid/tool/common";
import { event } from "../../src/fakturoid/tool/event";
import { expense } from "../../src/fakturoid/tool/expense";
import { expensePayment } from "../../src/fakturoid/tool/expensePayment";
import { inboxFile } from "../../src/fakturoid/tool/inboxFile";
import { todo } from "../../src/fakturoid/tool/todo";
import { InMemoryFileStaging } from "../../src/staging/storage";
import { createResponse, mockFetch } from "../testUtils/mock";
import { TestStrategy } from "../testUtils/strategy";

const createErrorResponse = (
	status: number,
	body: unknown,
	headers: Record<string, string> = {},
	cancel: Mock = vi.fn().mockResolvedValue(undefined),
): Response => {
	const text = typeof body === "string" ? body : JSON.stringify(body);

	return {
		blob: () => Promise.resolve(new Blob([text])),
		text: () => Promise.resolve(text),
		body: { cancel: cancel },
		ok: false,
		status: status,
		headers: new Headers(headers),
	} as unknown as Response;
};

const RATE_LIMITED = { error: "rate_limited", error_description: "Slow down" };
const fullPage = (offset = 0) => Array.from({ length: 40 }, (_, index) => ({ id: offset + index }));

describe("Expense update lines", () => {
	const parseLines = (lines: unknown[]) => UpdateExpenseSchema.safeParse({ lines: lines });

	test("new line needs name and unit_price", () => {
		expect(parseLines([{}]).success).toBe(false);
		expect(parseLines([{ name: "Only name" }]).success).toBe(false);
		expect(parseLines([{ unit_price: "10" }]).success).toBe(false);
		expect(parseLines([{ name: "New", unit_price: "10" }]).success).toBe(true);
	});

	test("new line may load from inventory instead", () => {
		expect(parseLines([{ sku: "ABC" }]).success).toBe(true);
		expect(parseLines([{ inventory_item_id: 5 }]).success).toBe(true);
	});

	test("existing line may be partially updated", () => {
		expect(parseLines([{ id: 3, unit_price: "20" }]).success).toBe(true);
		expect(parseLines([{ id: 3 }]).success).toBe(true);
	});

	test("_destroy requires id", () => {
		expect(parseLines([{ _destroy: true }]).success).toBe(false);
		expect(parseLines([{ _destroy: true, name: "x", unit_price: "1" }]).success).toBe(false);
		expect(parseLines([{ _destroy: true, id: 3 }]).success).toBe(true);
	});

	test("error message tells how to update", () => {
		const result = parseLines([{ name: "Forgot id" }]);

		expect(result.success).toBe(false);
		expect(result.error?.issues[0]?.message).toContain("include its id");
	});
});

describe("DateStringSchema", () => {
	test.each([
		["2026-11-14", "2026-11-14"],
		[" 2026-11-14 ", "2026-11-14"],
		["2026-11-14T00:30:00+01:00", "2026-11-14"],
		["2026-11-14T23:30:00Z", "2026-11-14"],
		["2024-02-29", "2024-02-29"],
	])("accepts %s", (input, expected) => {
		expect(DateStringSchema.parse(input)).toBe(expected);
	});

	test.each(["2026-13-01", "2026-02-30", "2025-02-29", "2026-11-141", "2026-11-14 garbage", "14.11.2026", ""])(
		"rejects %s",
		(input) => {
			expect(DateStringSchema.safeParse(input).success).toBe(false);
		},
	);
});

describe("Retry budget", () => {
	let mockedFetch: Mock<typeof global.fetch>;

	beforeEach(() => {
		mockedFetch = mockFetch();
		vi.useFakeTimers();
	});

	afterEach(() => {
		mockedFetch.mockReset();
		vi.useRealTimers();
	});

	test("waits the full announced reset within the budget", async () => {
		const cancel = vi.fn().mockResolvedValue(undefined);
		mockedFetch
			.mockResolvedValueOnce(createErrorResponse(429, RATE_LIMITED, { "X-RateLimit": "default;r=0;t=55" }, cancel))
			.mockResolvedValueOnce(createResponse({ id: 1 }));

		const promise = request(new TestStrategy(), "/test", "GET");
		await vi.advanceTimersByTimeAsync(54_999);
		expect(mockedFetch).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);

		await expect(promise).resolves.toStrictEqual({ id: 1 });
		expect(cancel).toHaveBeenCalledOnce();
	});

	test("honors Retry-After", async () => {
		mockedFetch
			.mockResolvedValueOnce(createErrorResponse(429, RATE_LIMITED, { "Retry-After": "3" }))
			.mockResolvedValueOnce(createResponse({ id: 1 }));

		const promise = request(new TestStrategy(), "/test", "POST", {});
		await vi.advanceTimersByTimeAsync(2999);
		expect(mockedFetch).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);

		await expect(promise).resolves.toStrictEqual({ id: 1 });
	});

	test("fails fast with the reset time when it exceeds the budget", async () => {
		mockedFetch.mockResolvedValue(createErrorResponse(429, RATE_LIMITED, { "X-RateLimit": "default;r=0;t=70" }));

		const error = await request(new TestStrategy(), "/test", "GET").catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(GeneralError);
		expect((error as Error).message).toBe("HTTP 429 rate_limited: Slow down (rate limit resets in 70 s)");
		expect(mockedFetch).toHaveBeenCalledTimes(1);
	});

	test("stops when the next wait would exceed the remaining budget", async () => {
		mockedFetch
			.mockResolvedValueOnce(createErrorResponse(429, RATE_LIMITED, { "X-RateLimit": "default;r=0;t=50" }))
			.mockResolvedValueOnce(createErrorResponse(429, RATE_LIMITED, { "X-RateLimit": "default;r=0;t=20" }));

		const promise = request(new TestStrategy(), "/test", "GET").catch((caught: unknown) => caught);
		await vi.runAllTimersAsync();
		const error = await promise;

		expect((error as Error).message).toContain("resets in 20 s");
		expect(mockedFetch).toHaveBeenCalledTimes(2);
	});

	test("503 on GET gives up after 3 retries with backoff", async () => {
		mockedFetch.mockResolvedValue(createErrorResponse(503, "Maintenance"));

		const promise = request(new TestStrategy(), "/test", "GET").catch((caught: unknown) => caught);
		await vi.advanceTimersByTimeAsync(1000);
		expect(mockedFetch).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(2000);
		expect(mockedFetch).toHaveBeenCalledTimes(3);
		await vi.advanceTimersByTimeAsync(4000);
		expect(mockedFetch).toHaveBeenCalledTimes(4);

		expect(((await promise) as Error).message).toContain("HTTP 503");
	});
});

describe("Pagination from a later page", () => {
	let mockedFetch: Mock<typeof global.fetch>;

	beforeEach(() => {
		mockedFetch = mockFetch();
	});

	afterEach(() => {
		mockedFetch.mockReset();
	});

	test("page 3 with page_count 2 fetches pages 3 and 4 only", async () => {
		mockedFetch
			.mockResolvedValueOnce(createResponse(fullPage(80)))
			.mockResolvedValueOnce(createResponse(fullPage(120)))
			.mockResolvedValueOnce(createResponse(fullPage(160)));

		const result = await getInvoices(new TestStrategy(), "acc", { page: 3, page_count: 2, status: "open" });

		expect(result).toHaveLength(80);
		expect(mockedFetch.mock.calls.map((call) => call[0])).toStrictEqual([
			"https://test.example/accounts/acc/invoices.json?status=open&page=3",
			"https://test.example/accounts/acc/invoices.json?status=open&page=4",
		]);
		expect(listResult(result, 2, 3).content[1]).toMatchObject({ text: expect.stringContaining("request page 5") });
	});
});

describe("Staging timer", () => {
	test("cleanup timer does not keep the process alive", () => {
		const staging = new InMemoryFileStaging();
		const timer = (staging as unknown as { cleanupTimer: NodeJS.Timeout }).cleanupTimer;

		expect(timer.hasRef()).toBe(false);
	});
});

describe("Tools through a real MCP server", () => {
	const staging = new InMemoryFileStaging();
	const fakeClient = {
		createExpensePayment: vi.fn().mockResolvedValue({ id: 1 }),
		getEvents: vi.fn().mockResolvedValue([]),
		getInboxFiles: vi.fn().mockResolvedValue([]),
		getTodos: vi.fn().mockResolvedValue([]),
		updateExpense: vi.fn().mockResolvedValue({ id: 7 }),
	};
	let mcpClient: Client;
	let tempDir: string;

	beforeAll(async () => {
		const server = new McpServer({ name: "test", version: "0" });
		for (const tool of [...event, ...todo, ...inboxFile, ...expense, ...expensePayment]) {
			tool(server, fakeClient as never, staging);
		}

		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		await server.connect(serverTransport);
		mcpClient = new Client({ name: "test-client", version: "0" });
		await mcpClient.connect(clientTransport);
		tempDir = await mkdtemp(path.join(tmpdir(), "fakturoid-mcp-test-"));
	});

	afterAll(async () => {
		await mcpClient.close();
		await rm(tempDir, { force: true, recursive: true });
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	test.each(["fakturoid_get_events", "fakturoid_get_todos", "fakturoid_get_inbox_files"])(
		"%s works without arguments",
		async (name) => {
			const result = await mcpClient.callTool({ name: name });

			expect(result.isError).toBeFalsy();
		},
	);

	test("tool without arguments still validates required fields", async () => {
		await expect(mcpClient.callTool({ name: "fakturoid_update_expense" })).rejects.toThrow(/Invalid arguments/);
	});

	test("listed schemas stay plain objects with descriptions", async () => {
		const { tools } = await mcpClient.listTools();
		const byName = new Map(tools.map((tool) => [tool.name, tool.inputSchema as Record<string, never>]));
		const events = byName.get("fakturoid_get_events") as {
			type: string;
			properties: Record<string, { description?: string }>;
		};
		const payment = byName.get("fakturoid_create_expense_payment") as {
			properties: { paymentData: { properties: { paid_on: { description?: string } } } };
		};

		expect(events.type).toBe("object");
		expect(Object.keys(events.properties)).toEqual(
			expect.arrayContaining(["since", "subject_id", "page", "page_count"]),
		);
		expect(events.properties.page?.description).toContain("40 items per page");
		expect(payment.properties.paymentData.properties.paid_on.description).toContain("YYYY-MM-DD");
	});

	test("update_expense rejects a line that would be duplicated", async () => {
		await expect(
			mcpClient.callTool({
				arguments: { id: 7, updateData: { lines: [{ name: "Forgot id" }] } },
				name: "fakturoid_update_expense",
			}),
		).rejects.toThrow(/include its id/);
		expect(fakeClient.updateExpense).not.toHaveBeenCalled();
	});

	test("update_expense resolves file_ref from staging", async () => {
		const ref = await staging.store({
			content: new TextEncoder().encode("%PDF-1.4").buffer as ArrayBuffer,
			filename: "invoice.pdf",
			mimeType: "application/pdf",
		});

		await mcpClient.callTool({
			arguments: { id: 7, updateData: { attachments: [{ file_ref: ref }] } },
			name: "fakturoid_update_expense",
		});

		expect(fakeClient.updateExpense).toHaveBeenCalledWith(7, {
			attachments: [{ data_url: `data:application/pdf;base64,${btoa("%PDF-1.4")}`, filename: "invoice.pdf" }],
		});
	});

	test("update_expense reads file_path and keeps its name", async () => {
		const filePath = path.join(tempDir, "receipt.pdf");
		await writeFile(filePath, "%PDF-1.4");

		await mcpClient.callTool({
			arguments: { id: 7, updateData: { attachments: [{ file_path: filePath }] } },
			name: "fakturoid_update_expense",
		});

		const sent = fakeClient.updateExpense.mock.calls[0]?.[1] as {
			attachments: { data_url: string; filename: string }[];
		};
		expect(sent.attachments[0]?.filename).toBe("receipt.pdf");
		expect(sent.attachments[0]?.data_url).toBe(`data:application/pdf;base64,${btoa("%PDF-1.4")}`);
	});

	test("create_expense_payment sends paid_on as written", async () => {
		await mcpClient.callTool({
			arguments: { expenseId: 5, paymentData: { amount: "1", paid_on: "2026-11-14T00:30:00+01:00" } },
			name: "fakturoid_create_expense_payment",
		});

		expect(fakeClient.createExpensePayment).toHaveBeenCalledWith(5, { amount: "1", paid_on: "2026-11-14" });
	});
});
