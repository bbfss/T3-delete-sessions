import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeDeletedScratch } from '../src/cleaner.js';
test('removes whole deleted scratch including hidden directories, preserves shared and external workspaces', () => {
 const root=mkdtempSync(join(tmpdir(),'t3-scratch-test-'));
 try {
  mkdirSync(join(root,'userdata')); const dbPath=join(root,'userdata','statev2.sqlite');
  const db=new DatabaseSync(dbPath);
  db.exec('CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT,deleted_at TEXT,payload_json TEXT)');
  const insert=db.prepare('INSERT INTO orchestration_v2_projection_threads VALUES(?,?,?)');
  for(const [id,path,deleted] of [['a','scratch/a','yes'],['b','scratch/b','yes'],['c','scratch/b',null],['d','project','yes']]){
   const dir=join(root,path); mkdirSync(join(dir,'.agents','skills'),{recursive:true});
   insert.run(id,deleted,JSON.stringify({worktreePath:dir}));
  }
  db.close(); removeDeletedScratch(dbPath,['a','b','d']);
  assert.equal(existsSync(join(root,'scratch/a')),false);
  assert.equal(existsSync(join(root,'scratch/b')),true);
  assert.equal(existsSync(join(root,'project')),true);
 } finally {rmSync(root,{recursive:true,force:true});}
});
