"""Exercise preserve-current-subtree against a disposable running T3 instance."""
import json
import pathlib
import sqlite3
import subprocess
import time

p=pathlib.Path.cwd()
base=p/'t3-data'
db=base/'userdata/statev2.sqlite'
cli=str(p/'runtime/node_modules/.bin/t3')
plugin=p/'preserve-plugin'
url='http://127.0.0.1:13873'
env=(base/'userdata/environment-id').read_text().strip()


def command(payload):
    proc=subprocess.run(['node',str(plugin/'bin/t3-rpc.js')],input=json.dumps({'cli':cli,'baseDir':str(base),'url':url,'commands':[payload]}),text=True,capture_output=True,check=True)
    return json.loads(proc.stdout)


def launch(title):
    proc=subprocess.run([cli,'thread','start',str(p/'workspace'),'Fixture. Reply OK only.','--base-dir',str(base),'--title',title,'--provider','codex','--model','gpt-6.1-sol','--json'],text=True,capture_output=True,check=True)
    return json.loads(proc.stdout)['threadId']


def delegate(parent,title):
    with sqlite3.connect(db) as c:
        run=json.loads(c.execute('SELECT payload_json FROM orchestration_v2_projection_runs WHERE thread_id=? ORDER BY ordinal DESC LIMIT 1',(parent,)).fetchone()[0])
    command({'createdBy':'user','creationSource':'web','type':'delegated_task.request','parentThreadId':parent,'parentRunId':run['id'],'parentNodeId':run['rootNodeId'],'title':title,'task':'Reply OK only','modelSelection':{'instanceId':'codex','model':'gpt-6.1-sol'},'runtimeMode':'full-access','interactionMode':'default'})
    for _ in range(40):
        with sqlite3.connect(db) as c:
            rows=c.execute('SELECT child_thread_id FROM orchestration_v2_projection_subagents WHERE thread_id=? AND child_thread_id IS NOT NULL ORDER BY updated_at DESC',(parent,)).fetchall()
            for row in rows:
                child=c.execute('SELECT title FROM orchestration_v2_projection_threads WHERE thread_id=?',(row[0],)).fetchone()
                if child and child[0]==title:return row[0]
        time.sleep(.25)
    raise RuntimeError('Child not created')


def tool(name,args):
    proc=subprocess.run(['node',str(plugin/'bin/cli.js'),'--db',str(db),'--t3-url',url,'--t3-cli',cli,'--call',name,'--arguments-file','-'],input=json.dumps(args),capture_output=True,text=True,check=True)
    return json.loads(proc.stdout)


grand=launch('Disposable grandparent')
parent=delegate(grand,'Disposable parent')
current=delegate(parent,'KEEP current')
kept=delegate(current,'KEEP child')
sibling=delegate(parent,'DELETE sibling')
uncle=delegate(grand,'DELETE uncle')
other=launch('KEEP unrelated')
ids={'grand':grand,'parent':parent,'current':current,'kept':kept,'sibling':sibling,'uncle':uncle,'other':other}
edges={'grand':None,'parent':'grand','current':'parent','kept':'current','sibling':'parent','uncle':'grand','other':None}
registry={'nodes':[{'nodeId':name,'parentNodeId':edges[name],'t3':{'environmentId':env,'threadId':tid}} for name,tid in ids.items()]}
plan=tool('plan_cross_device_cleanup',{'registry':registry,'anchor_node_id':'current','current_environment_id':env,'current_thread_id':current,'scope':'preserve_current_subtree'})
assert {s['node_id'] for s in plan['steps']}=={'grand','parent','sibling','uncle'},plan
receipts=[]
for step in plan['steps']:
    r=tool('execute_cleanup_step',{'plan':plan,'node_id':step['node_id'],'receipts':receipts,'worker_thread_id':current,'dry_run':False})
    assert r['status']=='deleted',r
    receipts.append(r)
with sqlite3.connect(db) as c:
    for name,tid in ids.items():
        deleted=c.execute('SELECT deleted_at FROM orchestration_v2_projection_threads WHERE thread_id=?',(tid,)).fetchone()[0]
        assert bool(deleted)==(name in {'grand','parent','sibling','uncle'}),(name,deleted)
for tid in [current,kept,other]:
    proc=subprocess.run([cli,'thread','show',tid,'--base-dir',str(base),'--json'],capture_output=True,text=True,check=True)
    assert tid in proc.stdout
report={'t3Version':'0.1.7','nativeDelegationEdges':True,'ancestorsAndOtherBranchesDeleted':4,'currentSubtreePreserved':2,'unrelatedPreserved':True,'officialReadAfterDeletion':True,'modelGenerationVerified':False,'receipts':receipts}
(p/'preserve-subtree-report.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))
