import test from 'node:test';
import assert from 'node:assert/strict';
import { deliveryFiles } from '../../src/v2/delivery.mjs';
import { deliveryFileGuide, deliveryFilePresentation, deliveryReviewRequirements, reviewAttestationsComplete } from '../../web/src/delivery-presentation.ts';

const files = () => Object.fromEntries(deliveryFiles.map(name => [name, 'fictional test content']));

test('file guide covers every executable package file without claiming execution', () => {
  assert.deepEqual(deliveryFileGuide.map(f => f.name), deliveryFiles);
  for (const entry of deliveryFileGuide) { assert(entry.label); assert(entry.purpose); }
  assert.match(deliveryFileGuide.find(f => f.name === 'deployment.json').purpose, /不代表已部署/);
  assert.match(deliveryFileGuide.find(f => f.name === 'validation.json').purpose, /不是上线后的监控/);
});
test('preview has stable ordering and falls back if selection disappeared', () => {
  const content = Object.fromEntries(Object.entries(files()).reverse());
  assert.deepEqual(deliveryFilePresentation(content, 'missing').entries.map(f => f.name), deliveryFiles);
  assert.equal(deliveryFilePresentation(content, 'missing').active.name, 'schedule.json');
  assert.equal(deliveryFilePresentation(content, 'main.sql').active.name, 'main.sql');
  delete content['schedule.json'];
  assert.equal(deliveryFilePresentation(content, 'schedule.json').active.name, 'main.sql');
  assert.equal(deliveryFilePresentation({}, 'schedule.json').active, undefined);
});
test('missing and empty required files are visible; extra files never replace them', () => {
  for (const name of deliveryFiles) {
    for (const value of [undefined, '', '   ']) {
      const content = files();
      if (value === undefined) delete content[name]; else content[name] = value;
      content['extra.sql'] = 'SELECT 1';
      const result = deliveryFilePresentation(content, 'extra.sql');
      assert.deepEqual(result.missing, [name]);
      assert.equal(result.active.label, '附加文件');
    }
  }
});
test('review requires exact explicit attestations for the chosen scope', () => {
  for (const cloud of [true, false]) {
    const values = Object.fromEntries(deliveryReviewRequirements(cloud).map(item => [item.id, true]));
    assert.equal(reviewAttestationsComplete(values, cloud), true);
    assert.equal(reviewAttestationsComplete(values, !cloud), false);
    assert.equal(reviewAttestationsComplete({...values, surprise: true}, cloud), false);
    for (const key of Object.keys(values)) {
      assert.equal(reviewAttestationsComplete({...values, [key]: false}, cloud), false);
      const missing = {...values}; delete missing[key];
      assert.equal(reviewAttestationsComplete(missing, cloud), false);
    }
    assert.equal(reviewAttestationsComplete({a:true,b:true,c:true,d:true}, cloud), false);
  }
});
