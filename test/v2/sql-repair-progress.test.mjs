import test from "node:test";
import assert from "node:assert/strict";
import { sameSqlIgnoringLayout } from "../../src/v2/sql-repair-progress.mjs";

test("SQL progress comparison recognizes exact text and unquoted layout changes", () => {
  for (const [left, right] of [
    ["SELECT client_id, SUM(market_value) FROM positions GROUP BY client_id", "\nSELECT\tclient_id , SUM ( market_value )\nFROM positions\nGROUP BY client_id\n"],
    ["SELECT 1.25e-2 AS value", " SELECT\n1.25e-2\tAS\tvalue "],
    ["SELECT client_id -- same comment\nFROM accounts", "SELECT\nclient_id -- same comment\r\nFROM\taccounts"],
    ["SELECT /* outer /* nested */ note */ client_id FROM accounts", "SELECT\n/* outer /* nested */ note */\nclient_id FROM accounts"],
  ]) assert.equal(sameSqlIgnoringLayout(left, right), true);
});

test("comparison preserves string contents, escaped quotes, quoted identifiers, literal prefixes and token boundaries", () => {
  for (const [left, right] of [
    ["SELECT 'A  B'", "SELECT 'A B'"], ["SELECT 'A'", "SELECT 'a'"],
    ["SELECT `Client ID`", "SELECT `Client  ID`"], ['SELECT "Client"', 'SELECT "client"'],
    ["SELECT 'it''s'", "SELECT 'its'"], ["SELECT 'a\\\\b'", "SELECT 'a\\b'"],
    ["SELECT r'raw'", "SELECT r 'raw'"], ["SELECT X'FF'", "SELECT X 'FF'"],
    ["SELECT 1abc", "SELECT 1 abc"], ["SELECT 1e-3", "SELECT 1e - 3"], ["SELECT .5", "SELECT . 5"],
    ["SELECT a <= b", "SELECT a < = b"], ["SELECT a || b", "SELECT a | | b"],
    ["SELECT a - - b", "SELECT a -- b"], ["SELECT /*+ HINT_A */ a", "SELECT /*+ HINT_B */ a"],
    ["SELECT 'unterminated", "SELECT  'unterminated"], ["SELECT /* unterminated", "SELECT\n/* unterminated"],
    ["SELECT '-- internal text'", "SELECT '--  internal text'"],
    ["SELECT\u00a0client_id FROM accounts", "SELECT client_id FROM accounts"],
    ["SELECT\vclient_id FROM accounts", "SELECT client_id FROM accounts"],
  ]) assert.equal(sameSqlIgnoringLayout(left, right), false, `${left} must remain distinct from ${right}`);
  assert.equal(sameSqlIgnoringLayout("SELECT 'unterminated", "SELECT 'unterminated"), true, "identical failed source can be recognized without parsing");
  assert.equal(sameSqlIgnoringLayout("", ""), false); assert.equal(sameSqlIgnoringLayout(undefined, "SELECT 1"), false);
});
