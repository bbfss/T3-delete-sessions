#!/usr/bin/env python3
"""Delete a fixed, authorized postorder list after its owning app releases it."""
import json
import os
from pathlib import Path
import selectors
import subprocess
import sys
import time
import uuid


def read_thread(cli, session_id, cwd):
    process = subprocess.Popen([cli, 'app-server', '--stdio'], stdin=subprocess.PIPE,
                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                               text=True, bufsize=1)
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)

    def call(number, method, params):
        process.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': number,
                                       'method': method, 'params': params}) + '\n')
        process.stdin.flush()
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if selector.select(1):
                line = process.stdout.readline()
                if not line:
                    raise RuntimeError('Official app-server connection closed')
                message = json.loads(line)
                if message.get('id') == number:
                    return message
        raise TimeoutError(method)

    try:
        initialized = call(1, 'initialize', {'clientInfo': {
            'name': 'fixed-session-cleanup', 'version': '1.0'}})
        if 'error' in initialized:
            raise RuntimeError(initialized['error']['message'])
        process.stdin.write('{"jsonrpc":"2.0","method":"initialized"}\n')
        process.stdin.flush()
        response = call(2, 'thread/read', {'threadId': session_id, 'includeTurns': False})
        if 'result' in response:
            return {'exists': True}
        message = response.get('error', {}).get('message', '')
        if message == 'thread not loaded: ' + session_id:
            number = 3
            for archived in (False, True):
                cursor = None
                while True:
                    listing = call(number, 'thread/list', {
                        'cwd': cwd, 'archived': archived, 'cursor': cursor,
                        'limit': 100, 'sourceKinds': ['cli', 'vscode', 'exec',
                        'appServer', 'subAgent', 'subAgentReview', 'subAgentCompact',
                        'subAgentThreadSpawn', 'subAgentOther', 'unknown']})
                    number += 1
                    if 'error' in listing:
                        return {'exists': None, 'message': listing['error']['message']}
                    page = listing['result']
                    if any(t['id'] == session_id for t in page['data']):
                        return {'exists': True}
                    cursor = page.get('nextCursor')
                    if not cursor:
                        break
            return {'exists': False, 'message': message,
                    'verification': 'Absent from all-source active and archived official lists for verified cwd'}
        missing = session_id in message and ('no rollout found' in message.lower()
                                             or 'not found' in message.lower())
        return {'exists': False if missing else None, 'message': message}
    finally:
        selector.close()
        process.stdin.close()
        process.terminate()
        process.wait(timeout=5)


def main():
    request_path = Path(sys.argv[1]).resolve()
    request = json.loads(request_path.read_text())
    assert request['role'] == 'cleanup_worker' and request['mode'] == 'delete'
    assert request['authorizationSource'] and request['postorderSessionIds']
    if request.get('scope') != 'descendants_only':
        raise ValueError('Only descendants_only cleanup requests are supported')
    protected = request.get('protectedSessionIds')
    if not isinstance(protected, list):
        raise ValueError('protectedSessionIds must explicitly list the caller endpoints')
    for session_id in protected:
        if str(uuid.UUID(session_id)) != session_id:
            raise ValueError('Protected session IDs must be complete UUIDs')
    protected = set(protected)
    if os.environ.get('CODEX_THREAD_ID'):
        protected.add(os.environ['CODEX_THREAD_ID'])
    ids = request['postorderSessionIds']
    if protected.intersection(ids):
        raise ValueError('Refusing to delete the current or protected session')
    assert len(set(ids)) == len(ids)
    for session_id in ids:
        assert str(uuid.UUID(session_id)) == session_id
    result_path = Path(request['resultPath'])
    result = {'mode': 'delete', 'state': 'ready', 'pid': os.getpid(),
              'parentPid': os.getppid(), 'sessionIds': ids, 'endpoints': []}

    def save():
        result_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')

    save()
    deadline = time.monotonic() + 300
    while not Path(request['releaseSignalPath']).exists():
        if time.monotonic() > deadline:
            result['state'] = 'release_timeout'
            save()
            return
        time.sleep(1)
    # The signal authorizes deletion only after the coordinator requests release.
    time.sleep(3)
    for session_id in ids:
        endpoint = {'sessionId': session_id, 'status': 'unverified'}
        result['endpoints'].append(endpoint)
        try:
            before = read_thread(request['codexPath'], session_id, request['cwd'])
            if before['exists'] is False:
                endpoint.update(status='already_deleted', verification=before)
            elif before['exists'] is None:
                endpoint.update(status='unverified', verification=before)
            else:
                command = subprocess.run([request['codexPath'], 'delete', session_id, '--force'],
                                         capture_output=True, text=True, timeout=30)
                endpoint.update(exitCode=command.returncode,
                                output=(command.stdout + command.stderr).strip())
                after = read_thread(request['codexPath'], session_id, request['cwd'])
                endpoint.update(verification=after, status=(
                    'deleted' if after['exists'] is False else
                    'failed' if command.returncode else 'unverified'))
        except Exception as error:
            endpoint.update(status='failed', error=str(error))
        save()
        if endpoint['status'] not in ('deleted', 'already_deleted'):
            result['state'] = 'incomplete'
            save()
            return
    result['state'] = 'complete'
    save()


if __name__ == '__main__':
    main()
