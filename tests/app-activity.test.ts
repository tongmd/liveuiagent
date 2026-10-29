import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {appActivity,describeUiChanges} from '../server/app-activity.js';

test('activity updates cannot cross accounts and scene differences come from actual objects',()=>{
  const db=new Database(':memory:');
  try{
    const history=appActivity(db),id=history.start('alice','空间实验台','将氧原子向右移动1个单位','model');
    history.update('bob',id,'done','wrong owner');
    assert.equal((db.prepare('SELECT status FROM chat_history WHERE id=?').get(id) as any).status,'running');
    const old={type:'Scene3D',scene:{objects:[{id:'O',position:[0,0,0],color:'#ff0000'},{id:'H',position:[0,1,0]}]}};
    const next=structuredClone(old);next.scene.objects[0].position=[1,0,0];next.scene.objects[0].color='#8055cc';
    const summary=describeUiChanges(old,next);
    assert.match(summary,/O · 位置：\[0,0,0\] → \[1,0,0\]/);assert.match(summary,/#ff0000.*#8055cc/);assert.doesNotMatch(summary,/H/);
    history.update('alice',id,'done',summary);
    assert.equal((db.prepare('SELECT text FROM chat_history WHERE id=?').get(id) as any).text,summary);
  }finally{db.close();}
});
