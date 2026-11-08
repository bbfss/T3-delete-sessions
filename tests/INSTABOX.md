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
