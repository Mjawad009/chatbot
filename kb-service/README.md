# Insight Bot — Knowledge Base Service

A separate Python service: upload a file, it gets chunked, embedded, and
stored in Qdrant. The Node chat backend calls this service's HTTP API for
retrieval — it never does chunking/embedding itself, and this service never
does LLM generation. Same separation-of-concerns principle as the original
Crawl4AI-based plan, just scoped to file uploads instead of web crawling
(the two can coexist — both just feed the same Qdrant collections).

## Stack
- **LlamaIndex** — file loading, chunking (`SentenceSplitter`), and
  incremental ingestion (`IngestionPipeline` with `DocstoreStrategy.UPSERTS`)
- **fastembed** — local, free, ONNX-based embeddings (no PyTorch). Model:
  `BAAI/bge-small-en-v1.5`, 384 dimensions. Downloads automatically on first
  run — needs normal internet access to huggingface.co.
- **Qdrant** — vector storage. **One shared collection** (`QDRANT_COLLECTION_NAME`,
  default `kb_shared`) across all tenants — not one collection per tenant.
  Every point carries a `tenantId` payload field with a tenant-optimized
  index (`is_tenant=True` + tuned HNSW config, per Qdrant's own
  multi-tenancy guidance), and `search()` always filters by it — there's
  no code path that queries without a tenant scope. `QDRANT_URL` unset →
  embedded on-disk mode (dev only — payload indexes are a documented
  no-op there); set → a real instance (self-hosted or Qdrant Cloud), same
  client code either way.

## Setup
```bash
cd kb-service
python3 -m venv venv
. venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env       # fill in KB_SERVICE_API_KEY at minimum
uvicorn app:app --reload --port 8001
```

## How re-uploads work
A file is identified by `tenantId + filename`. Re-uploading the same
filename for the same tenant:
- **Unchanged content** → skipped, zero writes, `status: "unchanged"`
- **Changed content** → old chunks deleted, new ones written,
  `status: "ingested"`

Uploading a *different* filename adds alongside whatever that tenant already
has — nothing else gets touched. This is powered by LlamaIndex's
`IngestionPipeline` dedup, keyed off a content hash of the extracted text
(deliberately NOT including a timestamp in that hash — a timestamp changes
every call and would defeat dedup entirely, which is exactly the bug this
had before it was tested and fixed).

## API

All endpoints except `/health` require an `X-API-Key` header matching
`KB_SERVICE_API_KEY`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | No auth. Liveness + which Qdrant mode is active. |
| POST | `/ingest` | multipart: `file`, `tenantId` form field. Extracts, chunks, embeds, upserts. |
| GET | `/tenants/{tenantId}/files` | List ingested files with timestamps/char counts. |
| DELETE | `/tenants/{tenantId}/files/{filename}` | Remove a file's chunks. 404 if not found. |
| GET | `/search?tenantId=&query=&topK=5` | Semantic search, returns matched chunks + source file. |

Supported file types: `.pdf .docx .txt .md .csv .html .htm .json` (25MB
default limit, `KB_MAX_FILE_SIZE_MB` to change). Scanned/image-only PDFs
aren't OCR'd — skipped for now per the earlier scoping decision; add
`unstructured[ocr]` later if that's needed.

## Wiring into the Node backend (not built yet)
The natural next step: on a consultancy/survey tenant that has KB content,
`server.js`'s `/api/chat` would call `GET {KB_SERVICE_URL}/search` before
building the LLM prompt, and inject the returned chunks into the system
prompt as grounding context (with citations back to `sourceFile`). This
is the single biggest gap flagged a few turns back — RAG integration — and
this service is the piece that unblocks it. Not done in this pass;
say the word when you want that wired up.

## A note on this sandbox's testing
Model downloads from huggingface.co aren't reachable from the environment
this was built in, so the actual embedding step couldn't be run live here —
that's a sandbox network restriction, not a code issue; `fastembed` downloads
its model automatically the first time this runs anywhere with normal
internet access. Everything else — extraction, chunking, dedup-on-reupload,
Qdrant storage, search, delete, and the full HTTP API including auth and
error handling — was tested end-to-end with a stand-in embedder and is
confirmed working.
