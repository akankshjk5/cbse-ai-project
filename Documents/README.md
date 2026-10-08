# Documents

Local drop folder for source material (e.g. NCERT textbooks) destined for the
RAG corpus — the `documents` / `document_chunks` tables described in
`CLAUDE.md`.

Files placed here are not committed to git (see the root `.gitignore`); they
are inputs, not build artifacts.

**The Researcher reads this folder.** Every deck build lists it (pdf, docx,
txt, md, csv, json, html — up to 8 files) and hands what it finds to the
`researcher` specialist as the deck's primary evidence. With the folder empty,
that stage runs with live web search instead. So a file dropped here changes
what the next deck is built from — which is the point, and worth knowing before
you leave something unrelated in it.

It is per-install rather than per-deck because there is no per-deck document
upload yet: `asset_kind` has no `source` member and the create-deck form takes
only a style reference. When that path exists, `listSourceDocuments` in
`src/lib/generation/run.ts` grows a Supabase branch and this folder stays as
the local convenience it already is.

Still to come: the embedding pipeline described in `CLAUDE.md` — chunking each
file, embedding it with `GENAI_EMBED_MODEL` at 1536 dimensions, and writing the
rows to `documents` / `document_chunks` for retrieval across builds.
