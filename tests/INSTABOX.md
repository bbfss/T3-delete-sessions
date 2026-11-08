# InstaBox validation

Verified on 2026-11-08 with plugin commit
`5522c401f5c2e919bac34ca6c5c9733dc4921d7f`, T3 Code 0.1.7,
Linux x86_64 and Python 3.13 in an isolated InstaBox directory.

T3 was installed from the official `t3@0.1.7` npm launcher. Its server ran
on loopback port 13873 with a dedicated `--base-dir`. The official CLI
registered a project and created two threads. The server was stopped before
the plugin opened its database. No existing device databases or provider
credentials were copied into the sandbox.

The following checks passed through the plugin's Node launcher and MCP
JSON-RPC interface:

- Default preview left the real T3 thread's deletion field unset.
- A request naming another hostname was rejected.
- Explicit offline deletion marked the selected disposable thread and
  appended one `thread.deleted` database event.
- The second thread retained its unset deletion field.
- Course and scratch sentinel files retained their original contents.
- After restarting T3, its official `thread list --json` excluded the selected
  thread and included the preserved thread.
- All 10 synthetic database regression tests passed in the sandbox.

The test server was stopped after verification. The report was retained in
the sandbox at `/data/t3-cleaner-real-test-20261108/real-test-report.json`.

## Limits

The real-thread deletion selected no children (`childrenCount: 0`). Nested
descendants and orphan cascades were exercised by synthetic database tests,
not by a real provider-created agent family. Provider model generation,
native history deletion, live UI event delivery and the T3 sidebar delete
button were not verified. This validates offline compatibility with the
tested T3 schema, not an official live deletion integration.

## Online integration, version 1.2.0

A running T3 0.1.7 server created a parent through its CLI. Two official
`delegated_task.request` commands created a child and then a grandchild.
No SQL inserts or fabricated lineage were used. Provider model generation
was not exercised; the test required T3's real delegation records and lifecycle.

Through the plugin MCP entry point with `--t3-url` and offline writes disabled:

- Descendants-only cleanup deleted both child and grandchild while retaining the parent.
- A subsequent explicit parent deletion succeeded.
- An unrelated thread and the course/scratch sentinel files were retained.
- All writes used official `thread.stop` and `thread.delete` commands against
  the running server; projected states were checked after completion.

The result is retained at
`/data/t3-cleaner-real-test-20261108/online-test-report.json` in the sandbox.
The test server was stopped after completion. This extends the earlier offline
single-thread test with a real three-level T3 delegation family.

## Remote-first barrier, version 1.3.0

Validated on two separate InstaBox Linux machines, each running its own T3
0.1.7 installation and database. Official T3 CLI calls created disposable
coordinator and target threads on both machines. An explicit test registry
mapped the two target endpoints into a family; this tested the cross-machine
plan/receipt workflow, not native T3 peer delegation discovery.

1. A local execution request with no remote receipt returned `blocked` and
   left its target undeleted.
2. The remote machine executed its step through official T3 RPC and returned
   `deleted`, verified against that machine's database.
3. Passing that actual receipt to the local machine allowed its step to finish
   with `deleted`.
4. Both coordinator threads and sentinel course files remained intact. Both
   test T3 servers were stopped afterward.

The 19 regression tests include failure/preview/wrong-environment receipts,
protected current threads, unresolved endpoint IDs, remote-to-local ordering
conflicts, and already-deleted retries. The four slash skills pass skill validation.
Windows/VPS installation and a full model-driven delegated cleanup have not
been exercised by this two-Linux-machine test. Workers need their own local
runtime and existing authorized T3 access; credentials are not copied.

## Preserve current subtree, version 1.4.0

A fresh seven-node test on T3 0.1.7 used official CLI creation and native
`delegated_task.request` edges: grandparent, parent, current, current's child,
a sibling, an uncle and one unrelated thread. The new
`scope: preserve_current_subtree` plan deleted the four ancestors/other-branch
nodes. Current, its child and the unrelated thread remained readable through
the official `t3 thread show` interface after deletion. SQL deletion timestamps
matched the plan. Model generation was not verified.

Ancestor steps send only the precise official `thread.delete` command, without
recursive task cancellation. Protected side-chat children are blocked because
T3 cascades their parent's deletion; this guard has a regression test. The
plugin preserves historical lineage metadata rather than rewriting T3 records.
All 24 regression tests passed, including full ancestor scope, unrelated trees,
missing ancestor rejection, protected remote descendants, and side-chat blocking.
The test server was stopped after completion. Report:
`/data/home/t3-cross-test/preserve-subtree-report.json` on the sandbox.
