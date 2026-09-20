import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const moneyPattern = /^-?\d{1,16}(?:\.\d{1,6})?$/;

function micros(value) {
  const text = String(value);
  if (!moneyPattern.test(text)) throw new Error("INVALID_BILL_AMOUNT");
  if (text.startsWith("-")) return 0n;
  const [whole, fraction = ""] = text.split(".");
  return BigInt(whole) * 1_000_000n + BigInt((fraction + "000000").slice(0, 6));
}

export function verifyV2MonthlyBillPages(pages, budgetCny = 200) {
  if (!Array.isArray(pages) || pages.length < 1)
    return { ok: false, errors: ["BILL_PAGES_MISSING"] };
  try {
    const normalized = pages.map((page) => {
        if (page?.Success !== true || !Array.isArray(page?.Data?.Items?.Item))
          throw new Error("INVALID_BILL_PAGE");
        const pageNum = Number(page.Data.PageNum),
          pageSize = Number(page.Data.PageSize),
          totalCount = Number(page.Data.TotalCount),
          cycle = page.Data.BillingCycle;
        if (
          !Number.isSafeInteger(pageNum) ||
          pageNum < 1 ||
          !Number.isSafeInteger(pageSize) ||
          pageSize < 1 ||
          pageSize > 300 ||
          !Number.isSafeInteger(totalCount) ||
          totalCount < 0 ||
          typeof cycle !== "string" ||
          !/^\d{4}-\d{2}$/.test(cycle)
        )
          throw new Error("INVALID_BILL_PAGINATION");
        return { pageNum, pageSize, totalCount, cycle, items: page.Data.Items.Item };
      }),
      [first] = normalized;
    if (
      normalized.some(
        (page, index) =>
          page.pageNum !== index + 1 ||
          page.pageSize !== first.pageSize ||
          page.totalCount !== first.totalCount ||
          page.cycle !== first.cycle,
      )
    )
      throw new Error("BILL_PAGINATION_MISMATCH");
    const items = normalized.flatMap((page) => page.items);
    if (items.length !== first.totalCount)
      throw new Error("BILL_PAGES_INCOMPLETE");
    const totalMicros = items.reduce(
        (sum, item) => {
          if (item?.Currency !== "CNY") throw new Error("UNSUPPORTED_BILL_CURRENCY");
          return sum + micros(item?.PretaxAmount);
        },
        0n,
      ),
      totalCents = (totalMicros + 9_999n) / 10_000n,
      budgetCents = BigInt(Math.trunc(Number(budgetCny) * 100));
    if (budgetCents <= 0n) throw new Error("INVALID_BUDGET");
    return {
      ok: totalCents < budgetCents,
      spendCny: `${totalCents / 100n}.${String(totalCents % 100n).padStart(2, "0")}`,
      budgetCny: Number(budgetCny),
      belowBudget: totalCents < budgetCents,
      billingCycle: first.cycle,
      recordCount: items.length,
    };
  } catch (error) {
    return {
      ok: false,
      errors: [
        typeof error.message === "string" &&
        /^[A-Z][A-Z0-9_]{2,100}$/.test(error.message)
          ? error.message
          : "BILL_EVIDENCE_INVALID",
      ],
    };
  }
}

function run() {
  try {
    const paths = process.argv.slice(2);
    if (paths.length < 1 || paths.length > 100)
      throw new Error("BILL_PAGE_PATHS_INVALID");
    const result = verifyV2MonthlyBillPages(
      paths.map((path) => JSON.parse(readFileSync(path, "utf8"))),
      Number(process.env.V2_HARD_MONTHLY_BUDGET_CNY ?? 200),
    );
    process.stdout.write(JSON.stringify(result) + "\n");
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    const code =
      typeof error.message === "string" &&
      /^[A-Z][A-Z0-9_]{2,100}$/.test(error.message)
        ? error.message
        : "BILL_EVIDENCE_INVALID";
    process.stderr.write(JSON.stringify({ ok: false, code }) + "\n");
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) run();
