import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod/v3";
import type { AuthenticationStrategy } from "../../auth/strategy.js";
import type { FakturoidClient } from "../client.js";
import type { FileStaging } from "../../staging/storage.js";
import { PAGE_SIZE } from "../client/request.js";
import { logger } from "../../utils/logger.js";

type ServerToolCreator<
	Configuration extends object = object,
	Strategy extends AuthenticationStrategy<Configuration> = AuthenticationStrategy<Configuration>,
> = (server: McpServer, client: FakturoidClient<Configuration, Strategy>, staging: FileStaging) => void;

type LooseRegisterTool = (
	name: string,
	config: { title: string; description: string; inputSchema: z.ZodRawShape },
	callback: (input: unknown) => CallToolResult | Promise<CallToolResult>,
) => RegisteredTool;

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

			// Loosely typed on purpose: the SDK generics hit "Type instantiation is excessively deep".
			const registerTool = server.registerTool.bind(server) as unknown as LooseRegisterTool;
			const registeredTool = registerTool(
				name,
				{ title: title, description: description, inputSchema: inputSchema },
				(input) =>
					implementation(
						client,
						input as InputSchema extends z.ZodRawShape ? z.objectOutputType<InputSchema, z.ZodTypeAny> : undefined,
						staging,
					),
			);

			// Treat a call without `arguments` as `{}` (the SDK would reject it as "Required").
			const schemaWithDefault = z.object(inputSchema as z.ZodRawShape).default({});
			registeredTool.inputSchema = schemaWithDefault as unknown as NonNullable<typeof registeredTool.inputSchema>;

			return registeredTool;
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
