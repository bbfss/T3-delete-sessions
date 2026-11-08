"""Environment-aware cleanup plans with a remote-before-local barrier."""
import json
import sqlite3
import subprocess
from pathlib import Path
from contextlib import closing
from cleaner import find_descendant_tree, node_executable, sqlite_uri


def plan_cleanup(registry, anchor_node_id, current_environment_id, current_thread_id,
                 scope='descendants_only'):
    if scope not in ('descendants_only', 'preserve_current_subtree'):
        raise ValueError('Unknown cleanup scope')
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
    def postorder(root):
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
            ordered.append(key)
        walk(root)
        return ordered
    root = anchor_node_id
    ancestors = set()
    if scope == 'preserve_current_subtree':
        while nodes[root].get('parentNodeId') is not None:
            parent = nodes[root]['parentNodeId']
            if parent not in nodes:
                raise ValueError('Unresolved ancestor ' + parent)
            if parent in ancestors or parent == anchor_node_id:
                raise ValueError('Cycle in session registry')
            ancestors.add(parent)
            root = parent
    protected_ids = set(postorder(anchor_node_id)) if scope == 'preserve_current_subtree' else {anchor_node_id}
    protected = []
    for key in sorted(protected_ids):
        endpoint = nodes[key].get('t3') or {}
        if not endpoint.get('environmentId') or not endpoint.get('threadId'):
            raise ValueError('Unresolved protected endpoint for node ' + key)
        protected.append({'environment_id': endpoint['environmentId'], 'thread_id': endpoint['threadId']})
    protected_endpoints = {(p['environment_id'], p['thread_id']) for p in protected}
    ordered = [key for key in postorder(root) if key not in protected_ids]
    selected = set(ordered)
    steps, endpoints = [], set()
    for key in ordered:
        endpoint = nodes[key].get('t3') or {}
        env, tid = endpoint.get('environmentId'), endpoint.get('threadId')
        if not env or not tid:
            raise ValueError('Unresolved environment/thread for node ' + key)
        if (env, tid) in protected_endpoints:
            raise ValueError('A target aliases a protected thread')
        if (env, tid) in endpoints:
            raise ValueError('Multiple registry nodes alias the same endpoint')
        endpoints.add((env, tid))
        steps.append({'node_id': key, 'environment_id': env, 'thread_id': tid,
                      'phase': 'local' if env == current_environment_id else 'remote',
                      'depends_on': [c for c in children[key] if c in selected],
                      **({'ancestor': True} if key in ancestors else {})})
    by_id = {s['node_id']: s for s in steps}
    for step in steps:
        if step['phase'] == 'remote' and any(by_id[c]['phase'] == 'local' for c in step['depends_on']):
            raise ValueError('Remote-first order conflicts with a remote node delegating back locally: ' + step['node_id'])
    steps.sort(key=lambda s: s['phase'] == 'local')
    return {'scope': scope, 'order': 'remote_then_local',
            'anchor_node_id': anchor_node_id, 'family_root_node_id': root,
            'protected': protected, 'steps': steps}


def execute_step(plan, node_id, receipts, config, worker_thread_id, dry_run=True):
    if plan.get('scope') not in ('descendants_only', 'preserve_current_subtree') or plan.get('order') != 'remote_then_local':
        raise ValueError('Expected a supported remote-first plan')
    steps = {s['node_id']: s for s in plan['steps']}
    step = steps[node_id]
    env = (config.db.parent / 'environment-id').read_text(encoding='utf-8').strip()
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
    with closing(sqlite3.connect(sqlite_uri(config.db, 'ro'), uri=True)) as conn:
        conn.row_factory = sqlite3.Row
        row = conn.execute('SELECT deleted_at FROM orchestration_v2_projection_threads WHERE thread_id=?', (tid,)).fetchone()
        if row is None:
            return {**step, 'status': 'unverified', 'reason': 'Thread not found in this environment'}
        if row['deleted_at']:
            return {**step, 'status': 'already_deleted'}
        descendants = find_descendant_tree(conn, tid)
        for d in descendants:
            lineage = json.loads(d['payload_json']).get('lineage') or {}
            if (env, d['thread_id']) in protected and lineage.get('sideChat') is True and lineage.get('parentThreadId') == tid:
                return {**step, 'status': 'blocked', 'reason': 'T3 would cascade-delete a protected side chat; a supported detach operation is required'}
        remaining = [d for d in descendants if (env, d['thread_id']) not in protected]
        if remaining:
            return {**step, 'status': 'blocked', 'reason': 'Live local descendants remain; refresh the plan',
                    'remaining': [d['thread_id'] for d in remaining]}
    if dry_run:
        return {**step, 'status': 'ready'}
    commands = [{'type': 'thread.delete', 'threadId': tid}]
    if not step.get('ancestor'):
        commands.insert(0, {'type': 'thread.stop', 'threadId': tid, 'stopDelegatedTasks': False})
    proc = subprocess.run([node_executable(), str(Path(__file__).parent / 'bin/t3-rpc.js')],
        input=json.dumps({'cli': config.t3_cli, 'baseDir': str(config.db.parent.parent), 'url': config.t3_url,
                          'commands': commands}),
        text=True, encoding='utf-8', capture_output=True, timeout=40)
    if proc.returncode:
        return {**step, 'status': 'failed', 'reason': proc.stderr[-1500:]}
    with closing(sqlite3.connect(sqlite_uri(config.db, 'ro'), uri=True)) as conn:
        row = conn.execute('SELECT deleted_at FROM orchestration_v2_projection_threads WHERE thread_id=?', (tid,)).fetchone()
        for item in plan['protected']:
            protected_env, protected_tid = item['environment_id'], item['thread_id']
            if protected_env != env:
                continue
            kept = conn.execute('SELECT deleted_at FROM orchestration_v2_projection_threads WHERE thread_id=?', (protected_tid,)).fetchone()
            if kept is None or kept[0] is not None:
                return {**step, 'status': 'failed', 'reason': 'Protected thread preservation could not be verified', 'protected_thread_id': protected_tid}
    return {**step, 'status': 'deleted' if row and row[0] else 'unverified'}
