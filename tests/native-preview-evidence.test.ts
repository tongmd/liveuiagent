import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyVerifiedInitialContent, buildPresentation, buildPreviewWidget } from '../server/liveuiagent.js';

function stored(runtimeState: Record<string, unknown> = {}) {
  return { appId: 'marginalia', owner: 'test-owner', data: { notes: [] }, runtimeState,
    appPackage: { manifest: { intent: { itemLabel: 'note', presentation: {
      glyph: '📚', tileTagline: 'Your notes', metric: '24 notes', metricLabel: 'Saved', collection: 'Notes', actionVerb: 'Read',
    } } }, ui: { pages: [{ id: 'home', components: [{ id: 'root', type: 'view', props: { accent: '#5544aa' } }] }] } } } as any;
}

test('empty service preview never displays a design-generated count or pretends unknown means zero', () => {
  const app = stored({ entities: [], entityStats: [] });
  assert.deepEqual(buildPreviewWidget(app), { kind: 'empty', items: [], stats: [], itemLabel: 'note' });
  const presentation = buildPresentation(app)!;
  assert.equal(presentation.metric, ''); assert.equal(presentation.metricLabel, '');
  assert.equal(presentation.live, false); assert.equal(presentation.metricSource, 'none');
  assert.equal(presentation.glyph, '📚'); assert.equal(presentation.collection, 'Notes'); assert.equal(presentation.actionVerb, 'Read');
  assert.equal(app.appPackage.manifest.intent.presentation.metric, '24 notes', 'read projection does not rewrite old packages');
});

test('actual runtime statistics, including observed zero, override all design metrics consistently with widget evidence', () => {
  for (const value of ['3 notes', '0', 0]) {
    const app = stored({ entityStats: [{ label: 'Actual notes', value }], entities: [{ id: 7, name: 'Actual note' }] });
    const p = buildPresentation(app)!; const widget = buildPreviewWidget(app);
    assert.equal(p.metric, String(value)); assert.equal(p.metricLabel, 'Actual notes'); assert.equal(p.live, true);
    assert.equal(p.metricSource, 'runtime.entityStats'); assert.equal(p.rows, 1);
    assert.deepEqual(widget.stats, [{ label: 'Actual notes', value: String(value) }]);
    assert.equal(widget.items[0].name, 'Actual note');
  }
});

test('entities alone do not establish a total statistic; malformed statistics never activate a live metric', () => {
  const app = stored({ entities: [{ name: 'Observed note' }], entityStats: [null, {}, { label: 'Missing' }, { label: 'Null', value: null }, { label: 'Blank', value: ' ' }, { label: '', value: 99 }, { label: 'Object', value: { invented: 24 } }, { label: 'Invalid', value: NaN }] });
  const p = buildPresentation(app)!; const widget = buildPreviewWidget(app);
  assert.equal(p.metric, ''); assert.equal(p.live, false); assert.equal(p.rows, 1);
  assert.equal(widget.kind, 'entities'); assert.equal(widget.items[0].name, 'Observed note'); assert.deepEqual(widget.stats, []);
});

test('real cached evidence survives reopen and is not replaced by changed presentation samples', () => {
  const app = stored({ entities: [{ id: 7, name: 'Actual note' }], entityStats: [{ label: 'Saved', value: 1 }] });
  const before = buildPresentation(app);
  const reopened = JSON.parse(JSON.stringify(app)); reopened.appPackage.manifest.intent.presentation.metric = '900 fake notes';
  assert.deepEqual(buildPresentation(reopened), before);
  assert.deepEqual(buildPreviewWidget(reopened), buildPreviewWidget(app));
});


test('failed first-open evaluation cannot publish returned entities, statistics or summary', () => {
  for (const evaluation of [{ pass: false, deficiencies: ['Incomplete real read-back'] }, null, { pass: 'true' }]) {
    const app = stored({ entities: [], entityStats: [], intentResult: { subtitle: 'Not loaded' } });
    const before = JSON.parse(JSON.stringify(app.runtimeState));
    const published = applyVerifiedInitialContent(app, { entities: [{ id: 'unverified', name: 'Claimed note' }], stats: [{ label: 'Notes', value: '24' }], summary: 'Claimed all notes loaded', evaluation } as any);
    assert.equal(published, false); assert.deepEqual(app.runtimeState, before);
    assert.equal(buildPresentation(app)!.metric, ''); assert.equal(buildPreviewWidget(app).kind, 'empty');
  }
});

test('verified first-open read publishes actual cached content and an observed zero without inventing empty results', () => {
  const app = stored({ entities: [], entityStats: [], intentResult: { subtitle: 'Not loaded' } });
  const initial = { entities: [{ id: 'real', name: 'Actual note' }], stats: [{ label: 'Notes', value: '1' }], summary: 'Read actual note', evaluation: { pass: true, deficiencies: [] } };
  assert.equal(applyVerifiedInitialContent(app, initial), true);
  assert.deepEqual(app.runtimeState.entities, initial.entities); assert.deepEqual(app.runtimeState.entityStats, initial.stats);
  assert.equal(app.runtimeState.intentResult.subtitle, initial.summary); assert.equal(buildPresentation(app)!.metric, '1');
  const emptyApp = stored({ entities: [], entityStats: [], intentResult: { subtitle: 'Not loaded' } });
  assert.equal(applyVerifiedInitialContent(emptyApp, { entities: [], stats: [{ label: 'Notes', value: '0' }], summary: 'Verified empty collection', evaluation: { pass: true } }), true);
  assert.equal(buildPresentation(emptyApp)!.metric, '0'); assert.equal(buildPresentation(emptyApp)!.live, true);
  const unknown = stored({ intentResult: { subtitle: 'Not loaded' } });
  assert.equal(applyVerifiedInitialContent(unknown, null), false); assert.equal(buildPresentation(unknown)!.metric, '');
});
