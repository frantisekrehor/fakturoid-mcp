import { z } from "zod/v3";

const VatRatesSummarySchema = z.object({
	/** Base total */
	base: z.string(),
	/** Currency */
	currency: z.string(),
	/** Base total in account currency */
	native_base: z.string(),
	/** Account currency */
	native_currency: z.string(),
	/** VAT total in account currency */
	native_vat: z.string(),
	/** VAT total */
	vat: z.string(),
	/** VAT rate */
	vat_rate: z.union([z.number(), z.string()]),
});

const CreateAttachmentSchema = z.object({
	/** Attachment contents in the form of a Data URI */
	data_url: z.string(),
	/** Attachment file name. When omitted, Fakturoid derives it from the Data URI MIME type. */
	filename: z.string().optional(),
});

/** Pagination for list endpoints. Fakturoid returns 40 items per page. */
const PaginationSchema = z
	.object({
		/** First page to fetch (1-based). Default: 1 */
		page: z
			.number()
			.int()
			.positive()
			.describe(
				"First page to fetch (1-based, 40 items per page). Without page_count, all pages from here to the end are fetched.",
			),
		/** Maximum number of pages (40 items each) to fetch. Default: all pages */
		page_count: z
			.number()
			.int()
			.positive()
			.describe("Maximum number of pages (40 items each) to fetch. Default: all pages."),
	})
	.partial();

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * Date in the YYYY-MM-DD format.
 *
 * Accepts ISO datetimes too and keeps the calendar date as written, without
 * converting to UTC (so `2026-11-14T00:30+01:00` stays `2026-11-14`).
 */
const DateStringSchema = z
	.string()
	.describe("Date in the YYYY-MM-DD format, taken as written (no time zone conversion)")
	.transform((value, context) => {
		const match = DATE_PATTERN.exec(value.trim());
		const [, year, month, day] = match ?? [];
		const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
		const isRealDate =
			match != null &&
			date.getUTCFullYear() === Number(year) &&
			date.getUTCMonth() === Number(month) - 1 &&
			date.getUTCDate() === Number(day);

		if (!isRealDate) {
			context.addIssue({ code: z.ZodIssueCode.custom, message: "Expected a valid date in the YYYY-MM-DD format" });

			return z.NEVER;
		}

		return `${year}-${month}-${day}`;
	});

const CreateAttachmentToolSchema = z.object({
	/** Reference ID from the /upload page */
	file_ref: z.string().optional(),
	/** URL to fetch the file from */
	source_url: z.string().optional(),
	/** Local file path (only works when server runs locally) */
	file_path: z.string().optional(),
	/** Attachment contents in the form of a Data URI (fallback - prefer file_ref or source_url) */
	data_url: z.string().optional(),
	/** Attachment file name */
	filename: z.string().optional(),
});

type CreateAttachmentTool = z.infer<typeof CreateAttachmentToolSchema>;
type Pagination = z.infer<typeof PaginationSchema>;

const LegacyBankDetailsSchema = z.object({
	/** Bank account number */
	bank_account: z.string(),

	/** IBAN */
	iban: z.string(),

	/** BIC (for SWIFT payments) */
	swift_bic: z.string(),
});

type VatRatesSummary = z.infer<typeof VatRatesSummarySchema>;
type CreateAttachment = z.infer<typeof CreateAttachmentSchema>;
type LegacyBankDetails = z.infer<typeof LegacyBankDetailsSchema>;

export {
	VatRatesSummarySchema,
	CreateAttachmentSchema,
	CreateAttachmentToolSchema,
	LegacyBankDetailsSchema,
	PaginationSchema,
	DateStringSchema,
};
export type { VatRatesSummary, CreateAttachment, CreateAttachmentTool, LegacyBankDetails, Pagination };
