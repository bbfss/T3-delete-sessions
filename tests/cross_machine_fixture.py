"""Run only in a disposable T3 sandbox; fixtures use official commands."""
import json
import sqlite3
import subprocess
import sys
from pathlib import Path

root = Path.cwd()
base = root / 't3-data'
db = base / 'userdata/statev2.sqlite'
cli = str(root / 'runtime/node_modules/.bin/t3')
plugin = root / 'plugin'
url = 'http://127.0.0.1:13873'


def tool(name, args):
    proc = subprocess.run(['node', str(plugin / 'bin/cli.js'), '--db', str(db), '--t3-url', url,
                           '--t3-cli', cli, '--call', name, '--arguments-file', '-'],
                          input=json.dumps(args), capture_output=True, text=True, check=True)
    return json.loads(proc.stdout)


if sys.argv[1] == 'setup':
    workspace = root / 'workspace'
    workspace.mkdir(exist_ok=True)
    (workspace / 'keep.txt').write_text('preserve course files\n')
    subprocess.run([cli, 'project', 'add', str(workspace), '--base-dir', str(base), '--title', 'Cross-machine cleanup test'], check=True)
    proc = subprocess.run([cli, 'thread', 'start', str(workspace), 'Fixture only. Reply OK.', '--base-dir', str(base),
                           '--provider', 'codex', '--model', 'gpt-6.1-sol', '--json'], capture_output=True, text=True, check=True)
    created = json.loads(proc.stdout)
    coordinator = subprocess.run([cli, 'thread', 'start', str(workspace), 'Fixture coordinator. Reply OK.', '--base-dir', str(base), '--provider', 'codex', '--model', 'gpt-6.1-sol', '--json'], capture_output=True, text=True, check=True)
    fixture = {'rootThreadId': json.loads(coordinator.stdout)['threadId'], 'environmentId': (base / 'userdata/environment-id').read_text().strip(), 'threadId': created['threadId']}
    (root / 'fixture.json').write_text(json.dumps(fixture))
    print(json.dumps(fixture))
else:
    request = json.loads((root / 'request.json').read_text())
    result = tool('execute_cleanup_step', request)
    with sqlite3.connect(db) as conn:
        tid = next(s['thread_id'] for s in request['plan']['steps'] if s['node_id'] == request['node_id'])
        deleted = conn.execute('SELECT deleted_at FROM orchestration_v2_projection_threads WHERE thread_id=?', (tid,)).fetchone()[0]
    expected = request.get('expect_status')
    if expected:
        assert result['status'] == expected, result
    if result['status'] == 'blocked':
        assert deleted is None
    elif result['status'] == 'deleted':
        assert deleted
    assert (root / 'workspace/keep.txt').read_text() == 'preserve course files\n'
    (root / 'receipt.json').write_text(json.dumps(result))
    print(json.dumps(result))
