"""Environment-aware cleanup plans with a remote-before-local barrier."""
import json
import sqlite3
import subprocess
from pathlib import Path
from contextlib import closing
from cleaner import find_descendant_tree


def plan_cleanup(registry, anchor_node_id, current_environment_id, current_thread_id):
    nodes = {n['nodeId']: n for n in registry['nodes']}
    if len(nodes) != len(registry['nodes']):
        raise ValueError('Duplicate registry node IDs')
    if anchor_node_id not in nodes:
        raise ValueError('Anchor is absent from the registry')
    anchor = nodes[anchor_node_id]
    if anchor.get('t3') != {'environmentId': current_environment_id, 'threadId': current_thread_id}:
        raise ValueError('Anchor must match the invoking environment and thread')
    children = {key: [] for key in nodes}
    for key, n in nodes.items():
        if n.get('parentNodeId') in children:
            children[n['parentNodeId']].append(key)
    visiting, visited, ordered = set(), set(), []
    def walk(key):
        if key in visiting:
            raise ValueError('Cycle in session registry')
        if key in visited:
            return
        visiting.add(key)
        for child in children[key]:
            walk(child)
        visiting.remove(key)
        visited.add(key)
        if key != anchor_node_id:
            ordered.append(key)
    walk(anchor_node_id)
    steps, endpoints = [], set()
    for key in ordered:
        n = nodes[key]
        endpoint = n.get('t3') or {}
        env, tid = endpoint.get('environmentId'), endpoint.get('threadId')
        if not env or not tid:
            raise ValueError('Unresolved environment/thread for node ' + key)
        if (env, tid) == (current_environment_id, current_thread_id):
            raise ValueError('A descendant aliases the protected current thread')
        if (env, tid) in endpoints:
            raise ValueError('Multiple registry nodes alias the same endpoint')
        endpoints.add((env, tid))
        steps.append({'node_id': key, 'environment_id': env, 'thread_id': tid,
                      'phase': 'local' if env == current_environment_id else 'remote',
                      'depends_on': children[key]})
    by_id = {s['node_id']: s for s in steps}
    for step in steps:
        if step['phase'] == 'remote' and any(by_id[c]['phase'] == 'local' for c in step['depends_on']):
            raise ValueError('Remote-first order conflicts with a remote node delegating back locally: ' + step['node_id'])
    steps.sort(key=lambda s: s['phase'] == 'local')
    return {'scope': 'descendants_only', 'order': 'remote_then_local',
            'anchor_node_id': anchor_node_id,
            'protected': [{'environment_id': current_environment_id, 'thread_id': current_thread_id}],
            'steps': steps}


def execute_step(plan, node_id, receipts, config, worker_thread_id, dry_run=True):
    if plan.get('scope') != 'descendants_only' or plan.get('order') != 'remote_then_local':
        raise ValueError('Expected a descendants-only remote-first plan')
    steps = {s['node_id']: s for s in plan['steps']}
    step = steps[node_id]
    env = (config.db.parent / 'environment-id').read_text().strip()
    if step['environment_id'] != env:
        raise ValueError('Step belongs to another T3 environment')
    protected = {(p['environment_id'], p['thread_id']) for p in plan['protected']}
    protected.add((env, worker_thread_id))
    if (env, step['thread_id']) in protected:
        raise ValueError('Cannot stop or delete the current/coordinator thread')
    def confirmed(key):
        expected = steps[key]
        return any(r.get('node_id') == key and r.get('environment_id') == expected['environment_id']
                   and r.get('thread_id') == expected['thread_id'] and r.get('status') in ('deleted', 'already_deleted')
                   for r in receipts)
    required = list(step['depends_on'])
    if step['phase'] == 'local':
        required += [s['node_id'] for s in steps.values() if s['phase'] == 'remote']
    missing = [key for key in required if not confirmed(key)]
    if missing:
        return {**step, 'status': 'blocked', 'pending': sorted(set(missing))}
    if not config.t3_url:
        raise ValueError('Cross-device cleanup requires official online T3 commands')
    tid = step['thread_id']
    with closing(sqlite3.connect(config.db.resolve().as_uri() + '?mode=ro', uri=True)) as conn:
        conn.row_factory = sqlite3.Row
        row = conn.execute('SELECT deleted_at FROM orchestration_v2_projection_threads WHERE thread_id=?', (tid,)).fetchone()
        if row is None:
            return {**step, 'status': 'unverified', 'reason': 'Thread not found in this environment'}
        if row['deleted_at']:
            return {**step, 'status': 'already_deleted'}
        descendants = find_descendant_tree(conn, tid)
        if descendants:
            return {**step, 'status': 'blocked', 'reason': 'Live local descendants remain; refresh the plan',
                    'remaining': [d['thread_id'] for d in descendants]}
    if dry_run:
        return {**step, 'status': 'ready'}
    proc = subprocess.run(['node', str(Path(__file__).parent / 'bin/t3-rpc.js')],
        input=json.dumps({'cli': config.t3_cli, 'baseDir': str(config.db.parent.parent), 'url': config.t3_url,
                          'commands': [{'type': 'thread.stop', 'threadId': tid, 'stopDelegatedTasks': False},
                                       {'type': 'thread.delete', 'threadId': tid}]}),
        text=True, capture_output=True, timeout=40)
    if proc.returncode:
        return {**step, 'status': 'failed', 'reason': proc.stderr[-1500:]}
    with closing(sqlite3.connect(config.db.resolve().as_uri() + '?mode=ro', uri=True)) as conn:
        row = conn.execute('SELECT deleted_at FROM orchestration_v2_projection_threads WHERE thread_id=?', (tid,)).fetchone()
    return {**step, 'status': 'deleted' if row and row[0] else 'unverified'}
