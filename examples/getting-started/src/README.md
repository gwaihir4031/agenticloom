# src/

This is the working directory the pipeline's agents implement into. When
you run chapters 5 and 6, the `implementer` and `tester` agents write
real TypeScript here (for example `rateLimiter.ts` and
`rateLimiter.test.ts`) and edit it across retries.

It starts essentially empty on purpose — watch it fill in as the pipeline
runs. (The agents' `produces:` hand-off notes land separately, under
`loom/runs/<id>/`.)
