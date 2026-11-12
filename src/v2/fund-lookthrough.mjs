import { readFileSync } from "node:fs";
import { fundCase, fundContextId, fundContextIds } from "./fund-contexts.mjs";
export { fundContextId } from "./fund-contexts.mjs";

const fixtureFile = name => readFileSync(new URL(`../../fixtures/fund-lookthrough/${name}`, import.meta.url), "utf8");
const fixtures = new Map(fundContextIds.map(id => [id, JSON.parse(fixtureFile(fundCase(id).file))]));
const { sourceTables, ...contract } = JSON.parse(fixtureFile("contract.json"));
export const fundReferenceSql = fixtureFile("reference.sql");

export function fundContext(id = fundContextId) {
  const fixture = fixtures.get(id);
  if (!fixture) return undefined;
  const portfolios = fixture.tables.portfolios.filter(row => row[1] === fixture.managerId);
  const ids = new Set(portfolios.map(row => row[0]));
  const fund_positions = fixture.tables.fund_positions.filter(row => ids.has(row[1]) && row[3] === fixture.businessDate);
  const funds = new Set(fund_positions.map(row => row[2]));
  const fund_allocations = fixture.tables.fund_allocations.filter(row => funds.has(row[0]) && row[1] === fixture.businessDate);
  const tables = { portfolios, fund_positions, fund_allocations };
  return structuredClone({
    id, name: fixture.name ?? contract.name, definition: contract.definition,
    managerId: fixture.managerId, businessDate: fixture.businessDate, classification: fixture.classification,
    outputContractId: contract.id, tables: sourceTables.map(table => ({ ...table, rows: tables[table.name] })),
    expected: fixture.expected,
  });
}

export function fundFamily(id = fundContextId) {
  const fixture = fixtures.get(id);
  return { id: contract.id, contextIds: [id], name: fixture.name ?? contract.name, definitionVersion: 1,
    outputContractId: contract.id, grain: contract.grain, keyFields: [...contract.keyFields],
    metricLabels: Object.fromEntries(contract.fields.map(field => [field.name, field.label])) };
}

export function fundOutputContract() {
  return { ...structuredClone(contract), referenceFile: "fund_lookthrough.sql" };
}
