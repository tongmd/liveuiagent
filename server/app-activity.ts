import type Database from 'better-sqlite3';
import {isDeepStrictEqual} from 'node:util';
import {redactSecrets} from './llm-settings.js';

/** Receipts use the same account-scoped history as the interaction panel. */
export function appActivity(db:Database.Database) {
  const ensure=()=>{
    db.exec(`CREATE TABLE IF NOT EXISTS chat_history(id INTEGER PRIMARY KEY AUTOINCREMENT,owner TEXT NOT NULL DEFAULT '',role TEXT NOT NULL,text TEXT NOT NULL,prompt TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
    const columns=new Set((db.prepare('PRAGMA table_info(chat_history)').all() as any[]).map(c=>c.name));
    for(const [name,value] of [['kind','chat'],['status',''],['label','']])if(!columns.has(name))db.exec(`ALTER TABLE chat_history ADD COLUMN ${name} TEXT NOT NULL DEFAULT '${value}'`);
  };
  return {
    start(owner:string,name:string,prompt:string,model:string){
      ensure();
      const id=Number(db.prepare("INSERT INTO chat_history(owner,role,text,prompt,kind,status,label) VALUES (?,'agent',?,?,'task','running',?)").run(owner,redactSecrets('正在生成修改'+(model?' · '+model:'')),redactSecrets(prompt).slice(0,2000),redactSecrets(name||'应用修改').slice(0,120)).lastInsertRowid);
      const cutoff=db.prepare('SELECT id FROM chat_history WHERE owner=? ORDER BY id DESC LIMIT 1 OFFSET 299').get(owner) as any;
      if(cutoff)db.prepare("DELETE FROM chat_history WHERE owner=? AND id<? AND NOT(kind='task' AND status='running')").run(owner,cutoff.id);
      return id;
    },
    update(owner:string,id:number|undefined,status:string,text:string){
      if(!id)return;
      db.prepare("UPDATE chat_history SET status=?,text=? WHERE owner=? AND id=? AND kind='task'").run(status,redactSecrets(text).slice(0,4000),owner,id);
    }
  };
}

export function describeUiChanges(before:any,after:any):string {
  if(isDeepStrictEqual(before,after))return '界面内容未变化';
  const scenes=(tree:any)=>{const result:any[]=[];const walk=(n:any)=>{if(n?.type==='Scene3D')result.push(n.scene);for(const child of n?.children||[])walk(child);};walk(tree);return result;};
  const old=scenes(before),next=scenes(after),changes:string[]=[];
  const fields:Record<string,string>={position:'位置',color:'颜色',scale:'尺寸',rotation:'旋转',shape:'形状',label:'名称'};
  for(let i=0;i<next.length;i++){
    const previous=new Map((old[i]?.objects||[]).map((o:any)=>[o.id,o]));
    for(const object of next[i]?.objects||[]){const prior:any=previous.get(object.id),name=String(object.label||object.id);
      if(!prior)changes.push('新增 '+name);
      else for(const [field,label] of Object.entries(fields))if(!isDeepStrictEqual(prior[field],object[field]))changes.push(name+' · '+label+'：'+JSON.stringify(prior[field]??null)+' → '+JSON.stringify(object[field]??null));
      previous.delete(object.id);
    }
    for(const object of previous.values() as any)changes.push('移除 '+String(object.label||object.id));
  }
  return changes.length?changes.slice(0,12).join('\n')+(changes.length>12?'\n另有 '+(changes.length-12)+' 项物体变化':''):'页面结构或内容已更新';
}

export function activityOutcome(job:any,summary:string,saved:boolean){
  return [(saved?'应用已更新并保存':'已生成修改，尚未确认保存'),summary,job.execution?.model,Math.max(0,Math.round((Date.parse(job.finishedAt||new Date().toISOString())-Date.parse(job.createdAt))/1000))+'秒'].filter(Boolean).join('\n');
}
