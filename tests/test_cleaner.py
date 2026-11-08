from contextlib import closing
import json
import socket
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from server import call_tool


class CleanerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.db = self.root / 'test.sqlite'
        self.artifact = self.root / 'scratch' / 'important.txt'
        self.artifact.parent.mkdir()
        self.artifact.write_text('keep')
        self.config = SimpleNamespace(db=self.db.resolve(), allow_offline_writes=True)
        self.args = dict(target_host=socket.gethostname(), db_path=str(self.db.resolve()))
        with closing(sqlite3.connect(self.db)) as c, c:
            c.executescript('''
            CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT PRIMARY KEY, title TEXT, default_provider TEXT, created_at TEXT, updated_at TEXT, archived_at TEXT, deleted_at TEXT, payload_json TEXT);
            CREATE TABLE orchestration_v2_projection_subagents(thread_id TEXT, child_thread_id TEXT);
            CREATE TABLE orchestration_events(event_id TEXT, aggregate_kind TEXT, stream_id TEXT, stream_version INTEGER, event_type TEXT, occurred_at TEXT, command_id TEXT, actor_kind TEXT, payload_json TEXT, metadata_json TEXT, application_event_version INTEGER);
            ''')
            for tid, parent in [('parent', None), ('child', 'parent'), ('grandchild', 'child'), ('unrelated', None)]:
                payload = {'worktreePath': str(self.artifact.parent)}
                if parent:
                    payload['lineage'] = {'parentThreadId': parent}
                c.execute('INSERT INTO orchestration_v2_projection_threads VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)', (tid, tid, 'codex', 'now', 'now', json.dumps(payload)))

    def deleted(self):
        with closing(sqlite3.connect(self.db)) as c, c:
            return [r[0] for r in c.execute('SELECT thread_id FROM orchestration_v2_projection_threads WHERE deleted_at IS NOT NULL ORDER BY thread_id')]

    def test_default_preview_preserves_everything(self):
        result = call_tool('delete_family', dict(self.args, thread_id='parent'), self.config)
        self.assertEqual(result['status'], 'preview')
        self.assertFalse(result['parentDeleted'])
        self.assertEqual([x['threadId'] for x in result['children']], ['grandchild', 'child'])
        self.assertEqual(self.deleted(), [])

    def test_missing_id_never_selects_recent_session(self):
        with self.assertRaises(ValueError):
            call_tool('delete_family', self.args, self.config)
        self.assertEqual(self.deleted(), [])

    def test_wrong_machine_or_database_is_rejected(self):
        for args in [dict(self.args, target_host='other-machine'), dict(self.args, db_path=str(self.root / 'other.sqlite'))]:
            with self.assertRaises(ValueError):
                call_tool('delete_orphans', dict(args, dry_run=False, offline_confirmed=True), self.config)
        self.assertEqual(self.deleted(), [])

    def test_write_requires_both_offline_gates(self):
        for enabled, confirmed in [(False, True), (True, False)]:
            self.config.allow_offline_writes = enabled
            with self.assertRaises(ValueError):
                call_tool('delete_family', dict(self.args, thread_id='parent', dry_run=False, offline_confirmed=confirmed), self.config)
        self.assertEqual(self.deleted(), [])

    def test_descendants_only_and_files_preserved(self):
        result = call_tool('delete_subsessions', dict(self.args, thread_id='parent', dry_run=False, offline_confirmed=True), self.config)
        self.assertFalse(result['parentDeleted'])
        self.assertEqual(self.deleted(), ['child', 'grandchild'])
        self.assertEqual(self.artifact.read_text(), 'keep')

    def test_orphan_cleanup_includes_grandchildren(self):
        with closing(sqlite3.connect(self.db)) as c, c:
            c.execute("UPDATE orchestration_v2_projection_threads SET deleted_at='before' WHERE thread_id='parent'")
        result = call_tool('delete_orphans', dict(self.args, dry_run=False, offline_confirmed=True), self.config)
        self.assertEqual(result['count'], 2)
        self.assertEqual(self.deleted(), ['child', 'grandchild', 'parent'])

    def test_archive_preserves_files_and_deleted_state(self):
        with closing(sqlite3.connect(self.db)) as c, c:
            c.execute("UPDATE orchestration_v2_projection_threads SET deleted_at='before' WHERE thread_id='parent'")
        call_tool('delete_orphans', dict(self.args, dry_run=False, offline_confirmed=True, archive_only=True), self.config)
        self.assertEqual(self.deleted(), ['parent'])
        self.assertEqual(self.artifact.read_text(), 'keep')
        with closing(sqlite3.connect(self.db)) as c, c:
            self.assertEqual(c.execute('SELECT count(*) FROM orchestration_v2_projection_threads WHERE archived_at IS NOT NULL').fetchone()[0], 2)

    def test_rpc_without_configuration_cannot_write(self):
        request = {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call', 'params': {'name': 'delete_family', 'arguments': dict(self.args, thread_id='parent', dry_run=False)}}
        output = subprocess.run([sys.executable, 'server.py'], input=json.dumps(request)+'\n', text=True, capture_output=True, check=True)
        self.assertTrue(json.loads(output.stdout)['result']['isError'])
        self.assertEqual(self.deleted(), [])

    def test_failed_event_insert_rolls_back_projection(self):
        with closing(sqlite3.connect(self.db)) as c, c:
            c.execute('DROP TABLE orchestration_events')
        with self.assertRaises(sqlite3.OperationalError):
            call_tool('delete_subsessions', dict(self.args, thread_id='parent', dry_run=False, offline_confirmed=True), self.config)
        self.assertEqual(self.deleted(), [])

    def test_non_boolean_dry_run_rejected(self):
        with self.assertRaises(ValueError):
            call_tool('delete_family', dict(self.args, thread_id='parent', dry_run='false'), self.config)
