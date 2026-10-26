import type Database from 'better-sqlite3';
/** Host-only durable admission witness shared by Native routes, SDK/scheduler
 * runtime calls and app-state writes. A read cannot grant business authority. */
export function requireGuiEpochAutocommit(db:Database.Database){if(db.inTransaction)throw Object.assign(Error('GUI business epoch requires an autocommit boundary; scope is not verifiable inside an outer transaction'),{status:409,code:'gui_field_proof_scope_changed'});}
export class GuiBusinessEpochs{
 constructor(private db:Database.Database){requireGuiEpochAutocommit(db);db.exec(`CREATE TABLE IF NOT EXISTS agent_gui_business_epochs(owner TEXT NOT NULL,app_id TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(owner,app_id))`);}
 read(owner:string,appId:string):string{requireGuiEpochAutocommit(this.db);const row=this.db.prepare('SELECT CAST(COALESCE(MAX(CASE WHEN owner=? THEN revision END),0) AS TEXT) AS own,CAST(COALESCE(SUM(revision),0) AS TEXT) AS all_app FROM agent_gui_business_epochs WHERE app_id=?').get(owner,appId) as any;return JSON.stringify([row.own,row.all_app]);}
 advance(owner:string,appId:string){requireGuiEpochAutocommit(this.db);this.db.prepare('INSERT INTO agent_gui_business_epochs(owner,app_id,revision) VALUES(?,?,1) ON CONFLICT(owner,app_id) DO UPDATE SET revision=revision+1').run(owner,appId);}
}
