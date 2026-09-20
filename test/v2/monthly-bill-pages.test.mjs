import test from "node:test";
import assert from "node:assert/strict";
import { verifyV2MonthlyBillPages } from "../../scripts/verify-v2-monthly-bill-pages.mjs";

const page = (pageNum, totalCount, items) => ({
  Success: true,
  Data: {
    BillingCycle: "2026-09",
    PageNum: pageNum,
    PageSize: 2,
    TotalCount: totalCount,
    Items: { Item: items },
  },
});

test("monthly bill verifier sums every page conservatively", () => {
  const result = verifyV2MonthlyBillPages([
    page(1, 3, [{ PretaxAmount: "0.591", Currency: "CNY" }, { PretaxAmount: 1, Currency: "CNY" }]),
    page(2, 3, [{ PretaxAmount: "2.000001", Currency: "CNY" }]),
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.spendCny, "3.60");
  assert.equal(result.recordCount, 3);
});

test("monthly bill verifier fails closed for incomplete pages", () => {
  const result = verifyV2MonthlyBillPages([
    page(1, 3, [{ PretaxAmount: "1", Currency: "CNY" }, { PretaxAmount: "2", Currency: "CNY" }]),
  ]);
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, ["BILL_PAGES_INCOMPLETE"]);
});

test("monthly bill verifier rejects a spend at or above the hard budget", () => {
  const result = verifyV2MonthlyBillPages([
    page(1, 1, [{ PretaxAmount: "200", Currency: "CNY" }]),
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.belowBudget, false);
  assert.equal(result.spendCny, "200.00");
});

test("monthly bill verifier ignores refunds conservatively and rejects mixed currency", () => {
  const refund = verifyV2MonthlyBillPages([
    page(1, 2, [{ PretaxAmount: "10", Currency: "CNY" }, { PretaxAmount: "-3", Currency: "CNY" }]),
  ]);
  assert.equal(refund.ok, true);
  assert.equal(refund.spendCny, "10.00");
  const foreign = verifyV2MonthlyBillPages([
    page(1, 1, [{ PretaxAmount: "1", Currency: "USD" }]),
  ]);
  assert.deepEqual(foreign.errors, ["UNSUPPORTED_BILL_CURRENCY"]);
});
