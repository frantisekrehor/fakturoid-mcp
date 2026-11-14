import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod/v3";
import type { AuthenticationStrategy } from "../../auth/strategy.js";
import type { FakturoidClient } from "../client.js";
import type { FileStaging } from "../../staging/storage.js";
import { logger } from "../../utils/logger.js";

type ServerToolCreator<
	Configuration extends object = object,
	Strategy extends AuthenticationStrategy<Configuration> = AuthenticationStrategy<Configuration>,
> = (server: McpServer, client: FakturoidClient<Configuration, Strategy>, staging: FileStaging) => void;

const createTool = <
	InputSchema extends z.ZodRawShape | undefined = undefined,
	Configuration extends object = object,
	Strategy extends AuthenticationStrategy<Configuration> = AuthenticationStrategy<Configuration>,
>(
	name: string,
	title: string,
	description: string,
	implementation: (
		client: FakturoidClient<Configuration, Strategy>,
		input: InputSchema extends z.ZodRawShape ? z.objectOutputType<InputSchema, z.ZodTypeAny> : undefined,
		staging: FileStaging,
	) => CallToolResult | Promise<CallToolResult>,
	inputSchema?: InputSchema,
): ServerToolCreator<Configuration, Strategy> => {
	return (server, client, staging) => {
		try {
			if (inputSchema == null) {
				return server.registerTool(name, { title: title, description: description }, () =>
					implementation(
						client,
						undefined as InputSchema extends z.ZodRawShape ? z.objectOutputType<InputSchema, z.ZodTypeAny> : undefined,
						staging,
					),
				);
			}

			// Yeah, we don't care for that, Typescript.
			// @ts-expect-error "Type instantiation is excessively deep and possibly infinite"
			return server.registerTool(name, { title: title, description: description, inputSchema: inputSchema }, (input) =>
				implementation(
					client,
					input as InputSchema extends z.ZodRawShape ? z.objectOutputType<InputSchema, z.ZodTypeAny> : undefined,
					staging,
				),
			);
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);

			logger.error("Failed to execute a tool.");
			logger.error(message);

			return {
				content: [{ isError: true, text: `Error: ${message}`, type: "text" }],
			};
		}
	};
};

const PAGE_SIZE = 40;

/**
 * Format a list result for a tool response.
 *
 * When `page_count` limited the fetch and the last page was full, more items
 * may exist; say so explicitly so the caller never mistakes it for a full list.
 */
const listResult = (items: unknown, pageCount?: number, page?: number): CallToolResult => {
	const content: CallToolResult["content"] = [{ text: JSON.stringify(items, null, 2), type: "text" }];

	if (Array.isArray(items) && pageCount != null && items.length >= pageCount * PAGE_SIZE) {
		const nextPage = (page ?? 1) + pageCount;
		content.push({
			text: `Note: result limited to ${pageCount} page(s) of ${PAGE_SIZE} items. More items may exist; request page ${nextPage} to continue.`,
			type: "text",
		});
	}

	return { content: content };
};

export { createTool, listResult };
export type { ServerToolCreator };
