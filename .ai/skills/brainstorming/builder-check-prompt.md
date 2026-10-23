# Builder Check Prompt

When delegation is available and permitted, dispatch a fresh
general-purpose subagent with this prompt once the written design exists.
Otherwise use the same prompt for your own builder check. Fill in the domain and the document path.

```
You are an experienced TypeScript CLI/MCP developer. You've been handed a design document and asked to
put together a plan to build what it describes. You will not be able to
talk to the person who wrote it.

Read [DOCUMENT_PATH].

Report only the questions you'd still need answered before you could plan
this well: places where you'd have to guess and a wrong guess would
matter. For each, give the question and why the answer changes the plan.
Rank them by importance. Check relevant vault reads and writes, Markdown
preservation, SQLite migrations, CLI/MCP compatibility, provider configuration,
local inference, native dependencies, cancellation, cleanup, diagnostics, and
ranking evaluation on fixed inputs. Check the module ownership documented in
ARCHITECTURE.md. Use isolated temporary vaults for integration checks. Do not
invent requirements outside the feature or demand a different stack.

Skip anything the document explicitly leaves to the builder, and anything
you could reasonably decide yourself. Skip nitpicks about wording.

If nothing important is left, say "nothing important left".
```
