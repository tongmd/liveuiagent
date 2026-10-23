import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runtimeEnvironment} from '../deploy/runtime.mjs';

test('deployment launcher preserves configured data and model settings while forcing a private bind',()=>{
  const parsed={OPENAI_API_KEY:'fixture-only',LIVEUIAGENT_ORCHESTRATOR_MODEL:'chosen',HOST:'0.0.0.0',PORT:'80',DB_PATH:'/existing/data.db',GENERATED_APPS_DIR:'/existing/apps',CHROME_PATH:'/existing/chrome'};
  const env=runtimeEnvironment(parsed,{},'/srv/example/shared',8791);
  assert.equal(env.HOST,'127.0.0.1');assert.equal(env.PORT,'8791');assert.equal(env.DB_PATH,'/existing/data.db');assert.equal(env.GENERATED_APPS_DIR,'/existing/apps');assert.equal(env.LIVEUIAGENT_ORCHESTRATOR_MODEL,'chosen');assert.equal(env.OPENAI_API_KEY,'fixture-only');assert.equal(env.LIVEUI_EVALUATION_DIR,'/srv/example/shared/evaluations');assert.equal(env.CHROME_PATH,'/existing/chrome');
  assert.throws(()=>runtimeEnvironment({DB_PATH:'./volatile.db'},{},'/shared',8791),/absolute persistent/);
  assert.throws(()=>runtimeEnvironment({LIVEUI_DEFAULT_HARNESS:'dsh'},{},'/shared',8791),/DSH default requires/);
});

test('launching through the current release symlink actually starts the server entrypoint',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'liveui-deploy-symlink-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const release=path.join(directory,'releases','fixture');const shared=path.join(directory,'shared');const current=path.join(directory,'current');
  await fs.mkdir(path.join(release,'deploy'),{recursive:true});await fs.mkdir(path.join(release,'dist-server','server'),{recursive:true});await fs.mkdir(shared);
  await fs.copyFile(new URL('../deploy/runtime.mjs',import.meta.url),path.join(release,'deploy','runtime.mjs'));
  await fs.symlink(fileURLToPath(new URL('../node_modules',import.meta.url)),path.join(release,'node_modules'),'dir');
  await fs.symlink(release,current,'dir');await fs.writeFile(path.join(release,'package.json'),'{"type":"module"}');
  const marker=path.join(directory,'started.json');const config=path.join(directory,'runtime.env');
  await fs.writeFile(config,'LIVEUI_DEFAULT_HARNESS=native\nLIVEUIAGENT_ORCHESTRATOR_MODEL=fixture-model\n');
  await fs.writeFile(path.join(release,'dist-server','server','index.js'),`import fs from 'node:fs/promises';\nawait fs.writeFile(process.env.TEST_MARKER,JSON.stringify({cwd:process.cwd(),host:process.env.HOST,port:process.env.PORT,db:process.env.DB_PATH,model:process.env.LIVEUIAGENT_ORCHESTRATOR_MODEL}));\n`);
  const result=spawnSync(process.execPath,[path.join(current,'deploy','runtime.mjs'),'start'],{encoding:'utf8',env:{PATH:process.env.PATH,LIVEUI_RUNTIME_ENV:config,LIVEUI_SHARED_DIR:shared,LIVEUI_PORT:'18791',TEST_MARKER:marker},timeout:10000});
  assert.equal(result.status,0,result.stderr);
  const started=JSON.parse(await fs.readFile(marker,'utf8'));
  assert.deepEqual(started,{cwd:await fs.realpath(release),host:'127.0.0.1',port:'18791',db:path.join(shared,'data','liveui.db'),model:'fixture-model'});
  assert.ok((await fs.stat(path.join(shared,'evaluations'))).isDirectory());
});

test('remote proxy and rollback tests execute without touching services or calling models',()=>{
  const result=spawnSync('python3',['-m','unittest','discover','-s','tests','-p','deployment_test.py','-v'],{encoding:'utf8'});
  assert.equal(result.status,0,result.stdout+result.stderr);
});

test('deployment CLI exposes actionable help and rejects missing SSH target before work',()=>{
  const help=spawnSync('bash',['scripts/deploy-liveui.sh','--help'],{encoding:'utf8'});assert.equal(help.status,0);assert.match(help.stdout,/--rollback/);assert.match(help.stdout,/--remote-env/);
  const missing=spawnSync('bash',['scripts/deploy-liveui.sh'],{encoding:'utf8'});assert.equal(missing.status,2);assert.match(missing.stderr,/--host/);
});

test('staged source archive includes latest files/deletions and excludes artifacts, papers and private configuration',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'liveui-deploy-source-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const git=(...args)=>{const result=spawnSync('git',args,{cwd:directory,encoding:'utf8'});assert.equal(result.status,0,result.stderr);return result.stdout;};
  git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
  for(const name of ['server','artifacts','papers','benchmarks'])await fs.mkdir(path.join(directory,name));
  await fs.writeFile(path.join(directory,'package.json'),'{}');await fs.writeFile(path.join(directory,'server/old.ts'),'old');
  for(const name of ['.env','artifacts/private.json','papers/paper.tex','benchmarks/cases.json'])await fs.writeFile(path.join(directory,name),'fixture excluded from deployment');
  git('add','-A');git('commit','-qm','old');await fs.rm(path.join(directory,'server/old.ts'));await fs.writeFile(path.join(directory,'server/new.ts'),'latest staged implementation');git('add','-A');
  const archive=path.join(directory,'source.tar.gz');
  const result=spawnSync('bash',['scripts/deploy-archive.sh',directory,archive,'staged'],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
  const listing=spawnSync('tar',['-tzf',archive],{encoding:'utf8'});assert.equal(listing.status,0);assert.match(listing.stdout,/server\/new.ts/);assert.doesNotMatch(listing.stdout,/old.ts|artifacts|papers|benchmarks|\.env/);
  const content=spawnSync('tar',['-xOzf',archive,'server/new.ts'],{encoding:'utf8'});assert.equal(content.stdout,'latest staged implementation');
  await fs.writeFile(path.join(directory,'server/new.ts'),'unstaged edit');
  const rejected=spawnSync('bash',['scripts/deploy-archive.sh',directory,archive,'staged'],{encoding:'utf8'});assert.equal(rejected.status,2);
});
