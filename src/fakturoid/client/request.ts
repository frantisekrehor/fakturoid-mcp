import type { AuthenticationStrategy } from "../../auth/strategy.js";
import {
	APIErrorSchema,
	type GeneralError as GeneralErrorType,
	type InvalidDataError as InvalidDataErrorType,
} from "../model/error.js";

const PAGE_SIZE = 40 as const;

/** Maximum number of retries for rate limited (429) or unavailable (503) responses. */
const MAX_RETRIES = 3 as const;
/**
 * Total time budget for waiting between retries, in milliseconds.
 * Fakturoid rate limit windows are 60 s, so one full window plus a margin fits.
 */
const RETRY_BUDGET_MS = 65_000 as const;
const MS_PER_SECOND = 1000 as const;
const BACKOFF_BASE = 2 as const;
const HTTP_TOO_MANY_REQUESTS = 429 as const;
const HTTP_SERVICE_UNAVAILABLE = 503 as const;
const RATE_LIMIT_RESET_PATTERN = /(?:^|[;,\s])t=(\d+(?:\.\d+)?)/;

class InvalidDataError extends Error {
	readonly data: InvalidDataErrorType;
	readonly status: number;

	constructor(data: InvalidDataErrorType, status = 422) {
		const details = Object.entries(data.errors)
			.map(([field, messages]) => `${field}: ${messages.join(", ")}`)
			.join("; ");

		super(`The request has failed due to invalid data being submitted (HTTP ${status}): ${details}`);

		this.data = data;
		this.status = status;
	}
}

class GeneralError extends Error {
	readonly data: GeneralErrorType;
	readonly status: number | undefined;

	constructor(data: GeneralErrorType, status?: number) {
		const description = data.error_description ?? data.error;
		super(status != null ? `HTTP ${status} ${data.error}: ${description}` : description);

		this.data = data;
		this.status = status;
	}
}

class UnexpectedError extends Error {
	readonly status: number | undefined;

	constructor(message: string, status?: number) {
		super(`The request has failed unexpectedly${status != null ? ` (HTTP ${status})` : ""}: ${message}`);

		this.status = status;
	}
}

const sleep = (milliseconds: number): Promise<void> =>
	new Promise((resolve) => {
		setTimeout(resolve, milliseconds);
	});

/**
 * Seconds until the rate limit resets, from `Retry-After` (seconds) or the `t=`
 * part of `X-RateLimit`. Undefined when the server does not say.
 */
const getResetSeconds = (headers: Headers | undefined): number | undefined => {
	const retryAfter = Number(headers?.get("retry-after"));
	if (Number.isFinite(retryAfter) && retryAfter > 0) {
		return retryAfter;
	}

	const rateLimitReset = Number(RATE_LIMIT_RESET_PATTERN.exec(headers?.get("x-ratelimit") ?? "")?.[1]);
	if (Number.isFinite(rateLimitReset) && rateLimitReset > 0) {
		return rateLimitReset;
	}

	return;
};

/** Wait until the announced reset, otherwise exponential backoff (1 s, 2 s, 4 s). */
const getRetryDelay = (headers: Headers | undefined, attempt: number): number => {
	const resetSeconds = getResetSeconds(headers);

	return resetSeconds != null ? resetSeconds * MS_PER_SECOND : MS_PER_SECOND * BACKOFF_BASE ** attempt;
};

/**
 * Fetch with retries for rate limited and unavailable responses.
 *
 * 429 means the request was not processed, so it is safe to retry for any method.
 * 503 (maintenance, overloaded search) is retried only for GET to avoid duplicate writes.
 */
const fetchWithRetry = async (url: string, requestData: RequestInit, method: string): Promise<Response> => {
	let response = await fetch(url, requestData);
	let waited = 0;

	for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
		const isRetryable =
			response.status === HTTP_TOO_MANY_REQUESTS || (response.status === HTTP_SERVICE_UNAVAILABLE && method === "GET");
		const delay = getRetryDelay(response.headers, attempt);

		// Give up (and report the reset time) rather than block past the budget.
		if (!isRetryable || waited + delay > RETRY_BUDGET_MS) {
			break;
		}

		// Release the discarded response before waiting.
		// biome-ignore lint/nursery/noAwaitInLoop: Sequential retries are intended
		await response.body?.cancel();
		await sleep(delay);
		waited += delay;
		response = await fetch(url, requestData);
	}

	return response;
};

/** Add the rate limit reset time to a 429 error so the caller knows when to try again. */
const withRateLimitHint = <ErrorType extends Error>(error: ErrorType, response: Response): ErrorType => {
	const resetSeconds = response.status === HTTP_TOO_MANY_REQUESTS ? getResetSeconds(response.headers) : undefined;
	if (resetSeconds != null) {
		error.message += ` (rate limit resets in ${Math.ceil(resetSeconds)} s)`;
	}

	return error;
};

const parseErrorBody = (text: string): unknown => {
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
};

const request = async <Response, Body = undefined>(
	strategy: AuthenticationStrategy,
	endpoint: string,
	method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
	body?: Body,
	queryParameters?: Record<string, string>,
): Promise<Response> => {
	const params = Object.entries(queryParameters ?? {})
		.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
		.join("&");

	const url = `${strategy.apiURL}${endpoint.startsWith("/") ? endpoint : `/${endpoint}`}${params.length > 0 ? `?${params}` : ""}`;

	const headers = await strategy.getHeaders({
		"Content-Type": "application/json",
		"User-Agent": `${strategy.appName} (${await strategy.getContactEmail()})`,
	});

	const requestData: RequestInit = {
		body: body != null ? JSON.stringify(body) : null,
		headers: Object.fromEntries(headers.entries()),
		method: method,
	};

	const response = await fetchWithRetry(url.toString(), requestData, method);
	const responseBody = await response.blob();

	if (!response.ok) {
		const errorText = await responseBody.text();
		const parsedError = APIErrorSchema.safeParse(parseErrorBody(errorText));
		if (!parsedError.success) {
			throw withRateLimitHint(new UnexpectedError(errorText, response.status), response);
		}

		if ("errors" in parsedError.data) {
			throw new InvalidDataError(parsedError.data, response.status);
		}

		throw withRateLimitHint(new GeneralError(parsedError.data, response.status), response);
	}

	const isJSON = response.headers.get("content-type")?.includes("application/json") ?? false;

	return (isJSON ? JSON.parse(await responseBody.text()) : responseBody) as Response;
};

async function* paginatedRequest<Item>(
	strategy: AuthenticationStrategy,
	endpoint: string,
	queryParameters?: Record<string, string>,
	page?: number,
): AsyncGenerator<Item[], undefined, undefined> {
	let currentPage = page ?? 1;

	while (true) {
		// biome-ignore lint/nursery/noAwaitInLoop: Usage in generator
		const response = await request<Item[]>(strategy, endpoint, "GET", undefined, {
			...queryParameters,
			page: String(currentPage),
		});

		if (response.length < PAGE_SIZE) {
			// Must yield, as returned values are not consumed in `for await` loops.
			yield response;

			return;
		}

		yield response;

		currentPage += 1;
	}
}

/**
 * Request pages of a list endpoint and concatenate them.
 *
 * @param pageCount - Maximum number of pages to fetch (default: all)
 * @param startPage - First page to fetch (default: 1)
 */
const requestAllPages = async <Item>(
	strategy: AuthenticationStrategy,
	endpoint: string,
	queryParameters?: Record<string, string>,
	pageCount?: number,
	startPage?: number,
): Promise<Item[]> => {
	const items: Item[] = [];
	let currentPage = 0;

	for await (const itemsPage of paginatedRequest<Item>(strategy, endpoint, queryParameters, startPage)) {
		if (itemsPage == null) {
			break;
		}

		items.push(...itemsPage);
		currentPage++;

		if (currentPage >= (pageCount ?? Number.MAX_VALUE)) {
			break;
		}
	}

	return items;
};

export { request, paginatedRequest, requestAllPages, GeneralError, InvalidDataError, UnexpectedError, PAGE_SIZE };
