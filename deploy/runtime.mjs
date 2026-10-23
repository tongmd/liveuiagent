import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import dotenv from 'dotenv';

export function runtimeEnvironment(parsed, inherited, shared, port, browser) {
  const env={...parsed,...inherited};
  env.HOST='127.0.0.1'; env.PORT=String(port); env.NODE_ENV='production';
  env.DB_PATH ||= path.join(shared,'data','liveui.db');
  env.GENERATED_APPS_DIR ||= path.join(shared,'generated-apps');
  env.LIVEUI_EVALUATION_DIR ||= path.join(shared,'evaluations');
  for(const key of ['DB_PATH','GENERATED_APPS_DIR','LIVEUI_EVALUATION_DIR'])if(!path.isAbsolute(env[key]))throw Error(`${key} must be an absolute persistent path`);
  env.LIVEUI_DEFAULT_HARNESS ||= 'native';
  env.CHROME_PATH=browser || env.CHROME_PATH;
  if(!['native','dsh'].includes(env.LIVEUI_DEFAULT_HARNESS))throw Error('LIVEUI_DEFAULT_HARNESS must be native or dsh');
  if(env.LIVEUI_DEFAULT_HARNESS==='dsh'&&!env.LIVEUIAGENT_DSH_API_BASE)throw Error('DSH default requires LIVEUIAGENT_DSH_API_BASE');
  return env;
}

async function main(){
  const mode=process.argv[2];
  const config=process.env.LIVEUI_RUNTIME_ENV;
  if(!config)throw Error('LIVEUI_RUNTIME_ENV must identify a private configuration file');
  const parsed=dotenv.parse(await fs.readFile(config));
  const shared=process.env.LIVEUI_SHARED_DIR;
  if(!shared||!path.isAbsolute(shared))throw Error('LIVEUI_SHARED_DIR must be absolute');
  const port=Number(process.env.LIVEUI_PORT||8791);
  if(!Number.isInteger(port)||port<1024||port>65535)throw Error('Invalid LIVEUI_PORT');
  let browser=process.env.LIVEUI_BROWSER_PATH || parsed.CHROME_PATH;
  if(mode==='prepare-browser'&&!browser){
    const {install,Browser}=await import('@puppeteer/browsers');
    const {PUPPETEER_REVISIONS}=await import('puppeteer-core');
    const installed=await install({browser:Browser.CHROME,buildId:PUPPETEER_REVISIONS.chrome,cacheDir:path.join(shared,'browsers'),installDeps:false});
    browser=installed.executablePath;
  }
  const env=runtimeEnvironment(parsed,process.env,shared,port,browser);
  if(mode==='prepare-browser'){
    if(!browser)throw Error('Chrome unavailable');
    const {default:puppeteer}=await import('puppeteer-core');
    const instance=await puppeteer.launch({executablePath:browser,headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
    try{const page=await instance.newPage();await page.setContent('<button onclick="this.textContent=\'ready\'">test</button>');await page.click('button');if(await page.$eval('button',el=>el.textContent)!=='ready')throw Error('Browser smoke check failed');}
    finally{await instance.close();}
    // Only the executable path is returned. Provider values are never logged.
    process.stdout.write(browser+'\n');return;
  }
  if(mode!=='start')throw Error('Expected start or prepare-browser');
  process.chdir(path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'));
  Object.assign(process.env,env);
  for(const dir of [path.dirname(env.DB_PATH),env.GENERATED_APPS_DIR,env.LIVEUI_EVALUATION_DIR])await fs.mkdir(dir,{recursive:true});
  await import('../dist-server/server/index.js');
}
// systemd enters through current/, while Node resolves this module to its release.
const invokedPath=process.argv[1]?await fs.realpath(process.argv[1]).catch(()=>undefined):undefined;
if(invokedPath===await fs.realpath(fileURLToPath(import.meta.url)))main().catch(error=>{console.error(error.message);process.exitCode=1;});
