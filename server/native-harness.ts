import type Database from 'better-sqlite3';
import type { HarnessId } from './runtime-settings.js';

/** Native package IDs no longer encode their inference harness. Persist that
 * affinity per owner so reopening a DSH-native app never silently changes it. */
export function createNativeHarnessBindings(db:Database.Database) {
 db.exec('CREATE TABLE IF NOT EXISTS native_harness_bindings(owner TEXT NOT NULL,app_id TEXT NOT NULL,harness TEXT NOT NULL,PRIMARY KEY(owner,app_id))');
 return {
  get(owner:string,appId:string):HarnessId|undefined {
   const row=db.prepare('SELECT harness FROM native_harness_bindings WHERE owner=? AND app_id=?').get(owner,appId) as {harness:HarnessId}|undefined;
   return row?.harness;
  },
  save(owner:string,appId:string,harness:HarnessId) {
   if(!appId||appId.startsWith('dsh_'))throw new Error('Native harness binding requires a Native application ID');
   if(harness!=='native'&&harness!=='dsh')throw new Error('Unknown Native inference harness');
   db.prepare('INSERT INTO native_harness_bindings(owner,app_id,harness) VALUES (?,?,?) ON CONFLICT(owner,app_id) DO UPDATE SET harness=excluded.harness').run(owner,appId,harness);
  },
 };
}

/** Existing HTML packages keep their original lifecycle. New applications use
 * Native AppSpec even when DSH supplies model reasoning. HTML delivery remains
 * available only through an explicit legacy API request, never the UI default. */
export function usesHtmlDelivery(body:Record<string,unknown>|undefined,selectedAppId?:string) {
 if(selectedAppId)return selectedAppId.startsWith('dsh_');
 return body?.delivery==='html';
}
