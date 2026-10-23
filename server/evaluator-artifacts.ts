import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type express from 'express';

const validRun = (value:string)=>/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const validFile = (value:string)=>/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}\.(png|json)$/.test(value);
const missing = ()=>Object.assign(new Error('Evaluation artifact not found'),{status:404,code:'artifact_not_found'});

/** Only evaluator-owned PNG/JSON files for the authenticated account are public. */
export function createEvaluatorArtifacts(root:string,userOf:(req:express.Request)=>string){
  root=path.resolve(root);
  const ownerDir=(req:express.Request)=>path.join(root,createHash('sha256').update(userOf(req)).digest('hex'));
  const directory=(req:express.Request)=>path.join(ownerDir(req),randomUUID());
  const url=(runId:string,filename:string)=>`/evaluator/artifacts/${runId}/${encodeURIComponent(filename)}`;
  async function safeRun(req:express.Request,runId:string){
    if(!validRun(runId))throw missing();
    const owner=ownerDir(req),run=path.join(owner,runId);
    for(const dir of [owner,run]){const stat=await fs.lstat(dir);if(!stat.isDirectory()||stat.isSymbolicLink())throw missing();}
    const actualRoot=await fs.realpath(root),actual=await fs.realpath(run);
    if(actual!==path.join(actualRoot,path.basename(owner),runId))throw missing();
    return run;
  }
  async function list(req:express.Request,runId:string){
    const run=await safeRun(req,runId);const files=[];
    for(const name of (await fs.readdir(run)).sort()){
      if(!validFile(name))continue;
      const stat=await fs.lstat(path.join(run,name));if(!stat.isFile()||stat.isSymbolicLink())continue;
      files.push({name,url:url(runId,name),type:name.endsWith('.png')?'image/png':'application/json'});
    }
    return files;
  }
  async function decorate(req:express.Request,report:any,outDir:string){
    const runId=path.basename(outDir);
    if(path.resolve(outDir)!==path.join(ownerDir(req),runId))throw missing();
    const files=await list(req,runId),byName=new Map(files.map(file=>[file.name,file.url]));
    function visit(value:any,imagePath=false):any{
      if(imagePath&&typeof value==='string'&&path.isAbsolute(value)&&path.dirname(value)===path.resolve(outDir))return byName.get(path.basename(value))||value;
      if(Array.isArray(value))return value.map(item=>visit(item,imagePath));
      if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,key==='finalStore'?item:visit(item,imagePath||key==='screenshot'||key==='screenshots')]));
      return value;
    }
    const {artifactsDir:ignored,...body}=report;
    const decorated={...visit(body),artifacts:{runId,reportUrl:url(runId,'report.json'),files}};
    // The downloadable report uses browser URLs too and contains no server-local paths.
    if(!byName.has('report.json'))decorated.artifacts.files.push({name:'report.json',url:url(runId,'report.json'),type:'application/json'});
    const output=await fs.open(path.join(outDir,'report.json'),constants.O_WRONLY|constants.O_CREAT|constants.O_TRUNC|constants.O_NOFOLLOW,0o600);
    try{await output.writeFile(JSON.stringify(decorated,null,2));}finally{await output.close();}
    return decorated;
  }
  function install(app:express.Express){
    app.get('/evaluator/artifacts/:runId/:filename',async(req,res,next)=>{
      let handle:Awaited<ReturnType<typeof fs.open>>|undefined;
      try{
        const runId=String(req.params.runId),filename=String(req.params.filename);
        if(!validFile(filename))throw missing();
        const run=await safeRun(req,runId);
        handle=await fs.open(path.join(run,filename),constants.O_RDONLY|constants.O_NOFOLLOW);
        const stat=await handle.stat();if(!stat.isFile()||stat.size>64*1024*1024)throw missing();
        res.set({'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Type':filename.endsWith('.png')?'image/png':'application/json; charset=utf-8'});
        if(filename.endsWith('.json'))res.set('Content-Disposition',`attachment; filename="${filename}"`);
        res.send(await handle.readFile());
      }catch(error:any){if(error.status===404||['ENOENT','ENOTDIR','ELOOP','EACCES'].includes(error.code))next(missing());else next(error);}
      finally{await handle?.close();}
    });
  }
  return {directory,decorate,install};
}
