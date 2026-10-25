import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

test('Expo and shipped web resolve explicit live root slots and row identities identically', async () => {
  const expo = await fs.readFile(new URL('../apps/shell/src/DynamicAppRenderer.tsx', import.meta.url), 'utf8');
  const body = name => {
    const start = expo.indexOf(`function ${name}`);
    const ends = [expo.indexOf('\nfunction ', start + 1), expo.indexOf('\nexport function ', start + 1)].filter(n => n >= 0);
    return expo.slice(start, Math.min(...ends));
  };
  const expoContext = {};
  vm.runInNewContext(ts.transpileModule(['requiredObject', 'requiredText', 'resolvePath', 'resolveActionContext'].map(body).join('\n') + '\nglobalThis.resolve = resolveActionContext;', {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText, expoContext);
  const snapshot = await fs.readFile(new URL('../frontend/snapshot/index.html', import.meta.url), 'utf8');
  const webBody = name => { const a=snapshot.indexOf(`function ${name}(`);return snapshot.slice(a,snapshot.indexOf('function ',a+10)); };
  const webContext = {};
  vm.runInNewContext('function Z(v,m){if(!v||typeof v!=="object"||Array.isArray(v))throw Error(m);return v}function $(v,m){if(typeof v!=="string"||!v.trim())throw Error(m);return v}\n'+webBody('Hl')+webBody('Wl')+'\nglobalThis.resolve=Wl;',webContext);
  for (const resolve of [expoContext.resolve, webContext.resolve]) {
    const root={id:'fake-root',entityName:'fake-root',draft:{slots:{folder:'new folder',amount:'stale amount'}}};
    const row={id:'second',entityName:'second item',draft:{slots:{folder:'forged row folder'}}};
    const move={entityId:{path:'/id'},entityName:{path:'/entityName'},folder:{path:'/draft/slots/folder'}};
    assert.deepEqual(JSON.parse(JSON.stringify(resolve(row,move,root))), {entityId:'second',entityName:'second item',folder:'new folder'});
    root.draft.slots.folder='newest folder';
    assert.equal(resolve(row,move,root).folder,'newest folder');
    assert.deepEqual(JSON.parse(JSON.stringify(resolve(row,{entityId:{path:'/id'}},root))),{entityId:'second'});
    assert.throws(()=>resolve(row,{unknown:{path:'/draft/slots/unknown'}},root),/Invalid row slot binding/);
    assert.throws(()=>resolve(row,{folder:{path:'/draft/slots/amount'}},root),/Invalid row slot binding/);
    assert.throws(()=>resolve(row,{entityId:{path:'/draft/slots/entityId'}},root),/Invalid row slot binding/);
  }
});
