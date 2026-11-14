# Model evaluation

Which model reads a buyer's request best, and does it matter? `requests.json` holds 12 hand-labelled purchase requests
(the four demo scenarios, Finnish phrasing, messy ones like "ten cases of oat milk by Thursday"). Each model gets the same
prompt and schema as `interpretRequest` (`src/lib/interpret.ts`), with the date fixed to `today` in the file so "by Monday"
has one right answer. `results.json` is what the script measured; `/models` and `GET /api/models` show it.

## Rerun

From `app/`:

```bash
node --conditions=react-server --env-file=.env.local scripts/eval-models.mts
```

It calls Gemma 4 and Gemini (`GEMINI_API_KEY`), Qwen 2.5 72B (`FEATHERLESS_API_KEY`) and Nemotron (`NVIDIA_API_KEY`): 12 calls per model, 60 s timeout each. A model whose env is missing is written as `not_run` with the reason.
Nothing is filled in: every number comes from a call made in that run.

## Add Nemotron

1. Create a key at build.nvidia.com (sign in, open the model page, "Get API Key"). Free tier is about 40 requests per minute; the client retries 429 with backoff.
2. The default model id is `nvidia/nemotron-3.5-super-vl-120b-a12b`, inferred from the model's URL
   (build.nvidia.com/nvidia/nemotron-3.5-super-vl-120b-a12b); the page's sample code leaves the `model` value blank. Once the key
   exists, confirm the id against the sample code. If it differs, set `NEMOTRON_MODEL`. A wrong id fails on every call and shows up as errors in the results.
3. Put `NVIDIA_API_KEY=...` (and `NEMOTRON_MODEL=...` only if the id differs) in `.env.local`, and in Vercel for the deployed site.
4. Rerun only Nemotron, keeping the other models' results:

```bash
node --conditions=react-server --env-file=.env.local scripts/eval-models.mts --only=nemotron
```

With the key set, `runExtractionModelStructured` also tries Nemotron first for page extraction, then falls back to Gemma and Qwen.

## Reading the numbers

- Valid JSON: output that parses and passes the zod schema. A timeout or API error counts as invalid.
- Field accuracy: share of all 12 requests whose field matched the label. Product matches if it contains an accepted keyword.
- Latency p50 and p95 are over valid answers (nearest rank; with 12 runs p95 is the slowest one).
- Agreement: per request, whether the models that answered gave the same amount and unit. These two fields drive the
  quantity and price that code computes, so disagreement there is the case where the choice of model would matter.
