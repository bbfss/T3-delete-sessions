import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from family import plan_cleanup, execute_step


def registry():
    return {'nodes': [
        {'nodeId': 'root', 'parentNodeId': None, 't3': {'environmentId': 'mac', 'threadId': 'current'}},
        {'nodeId': 'local', 'parentNodeId': 'root', 't3': {'environmentId': 'mac', 'threadId': 'local-child'}},
        {'nodeId': 'remote', 'parentNodeId': 'local', 't3': {'environmentId': 'win', 'threadId': 'remote-child'}},
        {'nodeId': 'grand', 'parentNodeId': 'remote', 't3': {'environmentId': 'vps', 'threadId': 'grandchild'}}]}


class FamilyTests(unittest.TestCase):
    def setUp(self):
        self.plan = plan_cleanup(registry(), 'root', 'mac', 'current')
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.db = Path(self.temp.name) / 'statev2.sqlite'
        (self.db.parent / 'environment-id').write_text('mac')
        self.config = SimpleNamespace(db=self.db, t3_url='http://127.0.0.1:3773', t3_cli='t3')

    def test_remote_then_local_postorder(self):
        self.assertEqual([s['node_id'] for s in self.plan['steps']], ['grand','remote','local'])
        self.assertEqual(self.plan['protected'], [{'environment_id':'mac','thread_id':'current'}])

    def test_local_blocked_without_all_remote_receipts(self):
        with patch('family.subprocess.run') as run:
            result = execute_step(self.plan,'local',[],self.config,'current',False)
        self.assertEqual(result['status'],'blocked')
        self.assertEqual(result['pending'],['grand','remote'])
        run.assert_not_called()

    def test_failed_wrong_environment_and_preview_receipts_do_not_unlock_local(self):
        for status, env in [('failed','vps'),('ready','vps'),('deleted','mac')]:
            receipts=[dict(self.plan['steps'][0],status=status,environment_id=env),dict(self.plan['steps'][1],status='deleted')]
            result=execute_step(self.plan,'local',receipts,self.config,'current',False)
            self.assertEqual(result['status'],'blocked')

    def test_worker_cannot_delete_itself(self):
        with self.assertRaisesRegex(ValueError,'current/coordinator'):
            execute_step(self.plan,'local',[],self.config,'local-child',False)

    def test_wrong_machine_rejected(self):
        with self.assertRaisesRegex(ValueError,'another T3 environment'):
            execute_step(self.plan,'remote',[],self.config,'current',False)

    def test_remote_delegating_back_locally_conflicts(self):
        r=registry();r['nodes'][3]['t3']['environmentId']='mac'
        with self.assertRaisesRegex(ValueError,'conflicts'):
            plan_cleanup(r,'root','mac','current')

    def test_unresolved_endpoint_blocks_plan(self):
        r=registry();r['nodes'][2]['t3']['environmentId']=None
        with self.assertRaisesRegex(ValueError,'Unresolved'):
            plan_cleanup(r,'root','mac','current')

    def test_protected_alias_rejected(self):
        r=registry();r['nodes'][2]['t3']=r['nodes'][0]['t3']
        with self.assertRaisesRegex(ValueError,'protected'):
            plan_cleanup(r,'root','mac','current')

    def test_deleted_retry_is_verified_without_commands(self):
        c=sqlite3.connect(self.db);c.execute('CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT,deleted_at TEXT)');c.execute("INSERT INTO orchestration_v2_projection_threads VALUES('local-child','done')");c.commit();c.close()
        receipts=[dict(s,status='deleted') for s in self.plan['steps'] if s['phase']=='remote']
        with patch('family.subprocess.run') as run:
            result=execute_step(self.plan,'local',receipts,self.config,'current',False)
        self.assertEqual(result['status'],'already_deleted');run.assert_not_called()
