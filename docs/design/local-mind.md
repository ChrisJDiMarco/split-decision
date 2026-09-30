# LOCAL mind: an open-source Jev on this Mac

Status 2026-09-29: bridge, adapter and brain switch built and tested against mock runtimes. No model is downloaded yet; the pull below waits for Chris's OK. Real latency and quality on this Mac are unmeasured until then.

## What it is

Each fighter's mind is one of four sources:

| Source | What decides | Network |
|--------|--------------|---------|
| JEV | TypeSafe's cloud Jev through `/api/jev` (unchanged) | api.typesafe.ai via the dev-server proxy |
| LOCAL | an open-source Jev-compatible decision model on this Mac through `/api/local-jev` | loopback only |
| HOUSE | the House Mind rules (`src/brain/house-mind.ts`) | none |
| YOU | the player (player mode, wired by the integration build) | none |

LOCAL sends the exact request JEV sends (same `state`, same `choice`/`noul`/`score` questions) and gets the same answer shape back, so the policy, gambles, reflexes and HUD do not know which model answered. When the local model is down or too slow, the House Mind fights and the MIND panel says `LOCAL OFFLINE → HOUSE`; the brain re-probes the model's health every 3 s and hands control back as soon as it answers.

## Which model

Recommended: **decider-4b v2.1, Q4_K_M GGUF, served by Ollama** (already installed here, 0.33.0).

| Model | Weights | License | Runs here via | Speaks /v1/systemone | Quality vs Jev |
|-------|---------|---------|---------------|----------------------|----------------|
| decider-4b v2.1 ([card](https://huggingface.co/Mapika/decider-4b-GGUF)) | Q4_K_M 2.71 GB, Q8_0 4.48 GB, BF16 8.42 GB | Apache-2.0 | Ollama (Metal) with our adapter | no (adapter) | JevBench hard 0.649 vs Jev 0.730 (card); README lists 0.676 on JevBench v1.5.2 |
| decider-2b v11 ([card](https://huggingface.co/Mapika/decider-2b-GGUF)) | Q4_K_M 1.27 GB, Q8_0 2.01 GB, BF16 3.78 GB | Apache-2.0 | same | no (adapter) | JevBench hard 0.577 |
| decider-2b native ([repo](https://github.com/Mapika/decider)) | 3.76 GB bf16 safetensors | Apache-2.0 | `pip install "decider-ai[metal]"`, MPS | yes | same model; exact prompt tokens; README: 133 ms median on an M1 Pro (fp16) |
| Kev-4B / Kev-0.8B ([repo](https://github.com/jaredpalmer/kev)) | not listed | Apache-2.0 | MLX via `uv`, `kev.serve` | yes | Kev-4B JevBench hard 0.541; README: 721 ms (4B) and 149 ms (0.8B) per new text on an M5; the card calls Qwen3.5 Kev "slow on a Mac" (no DeltaNet MPS kernels) |

Why decider-4b on Ollama: it is the strongest small open model on the Jev benchmark, Ollama runs Qwen3.5's DeltaNet layers on Metal (the Kev card's Mac bottleneck), and it needs one 2.7 GB pull and no Python, torch or MLX install. Kev and native decider need a Python stack and are slower on this hardware or limited to the 2B on MPS. Newer names exist (Laya, OpenJev, Von, JEV-27B; see [this comparison](https://rohitraj.tech/notes/jev-alternatives-open-weights-decision-models-2026)), but none has published Apple Silicon numbers that beat these, and the 26B-27B ones are too big for a fight cadence.

Ollama does not speak `/v1/systemone`, and the decider README warns that "loading one in llama-cli or Ollama gives a text model, not decisions". The adapter closes that gap, below. Kev cannot run on Ollama at all (it reads a pointer head, not the LM logits).

## How the adapter works (`server/systemone-adapter.ts`)

Ported from decider's own `systemone.py` and `prompt.py` (Apache-2.0):

1. The state is rendered as decider renders it (JSON, with `_index` written into arrays of 8 or more).
2. Each question becomes one row in decider's plain state-first layout:
   `Context:\n<state>\n\nQuestion: <instructions>\nOptions:\n(A) jab: ...\n(B) cross: ...\nAnswer: (`
   A `noul` renders as `(A) no (B) yes`. A `score` is judged the way decider's released configs judge it (`isolated_levels: true`): one yes/no row per level ("Proposed answer: <level>. Does the proposed answer fit?"), and the per-level P(yes) values are renormalised into the level distribution.
3. Ollama runs each row with `raw: true`, `num_predict: 1`, `logprobs: true`, `top_logprobs: 20`. The rows share the state prefix, so Ollama's KV cache pays for the state once per decision.
4. The option-letter log probabilities are divided by decider's fitted temperature for that answer type (4b: choice 1.11, noul 1.56, score 1.287; 2b: 1.164, 1.624, 1.124, from each repo's `decider_config.json`) and renormalised. Because logprob = logit − logsumexp, this equals decider's softmax(letter logits / T) exactly.
5. Answers are formatted like Jev: `choice` + `confidence` ((n·p_max − 1)/(n − 1)) + `probabilities`; `noul`; `score` (expected level) + `confidence` + `probabilities`.

Known gaps against the native runtime:
- A question with more than 20 options only sees the top 20 letters; the rest get a floor probability. Our largest question (tactic) has 16.
- For questions with more than 10 options decider builds the label tokens by id; we send text, so `(K` may tokenize slightly differently than in training.
- One HTTP call per row: a full brain decision is 14 rows (4 list questions plus 2 scores × 5 levels). Set `LOCAL_JEV_ISOLATED_LEVELS=0` to ask each score in one row (6 rows instead of 14) at some calibration cost.

`LOCAL_JEV_BACKEND=systemone` skips the adapter and passes the body straight to a native server (decider-ai's `decider.serve` or Kev's `kev.serve`).

## Setup (after Chris approves the download)

Recommended, one command, 2.71 GB into `~/.ollama`:

```bash
ollama pull hf.co/Mapika/decider-4b-GGUF:Q4_K_M
```

Nothing else: the bridge's defaults are Ollama at `http://127.0.0.1:11434` and that model name. Check it:

```bash
curl -s http://localhost:5297/api/local-jev/health
# {"ok":true,"model":"decider-4b","backend":"ollama","latencyMs":...}
npx tsx tests/brain/live-local.ts             # latency on 10 real fight states
COMPARE=1 npx tsx tests/brain/live-local.ts   # plus top-choice agreement with cloud Jev (10 Jev calls)
```

Faster, weaker (1.27 GB):

```bash
ollama pull hf.co/Mapika/decider-2b-GGUF:Q4_K_M
LOCAL_JEV_MODEL=hf.co/Mapika/decider-2b-GGUF:Q4_K_M npm run dev
```

Native decider server (exact tokenization; needs Python 3.12, torch and 3.76 GB of weights; not recommended yet):

```bash
python3.12 -m venv ~/.venvs/decider && ~/.venvs/decider/bin/pip install "decider-ai[metal]"
DECIDER_MODEL=Mapika/decider-2b ~/.venvs/decider/bin/uvicorn decider.serve:app --host 127.0.0.1 --port 8000
LOCAL_JEV_BACKEND=systemone LOCAL_JEV_URL=http://127.0.0.1:8000 LOCAL_JEV_MODEL=Mapika/decider-2b npm run dev
```

Bridge settings (environment of `npm run dev`):

| Variable | Default | Meaning |
|----------|---------|---------|
| `LOCAL_JEV_BACKEND` | `ollama` | `ollama` (adapter) or `systemone` (passthrough) |
| `LOCAL_JEV_URL` | `http://127.0.0.1:11434` (ollama), `http://127.0.0.1:8000` (systemone) | must be loopback; anything else is refused |
| `LOCAL_JEV_MODEL` | `hf.co/Mapika/decider-4b-GGUF:Q4_K_M` | runtime model name |
| `LOCAL_JEV_TIMEOUT_MS` | 3000 | whole request, queue wait included; then 504 |
| `LOCAL_JEV_MAX_CONCURRENT` | 1 | decisions running on the runtime at once |
| `LOCAL_JEV_MAX_QUEUE` | 4 | waiting beyond that; more get 429 |
| `LOCAL_JEV_ISOLATED_LEVELS` | on | `0` asks each score in one row |
| `LOCAL_JEV_TEMPERATURES` | from the model name | e.g. `choice=1.1,noul=1.5,score=1.2` |

## How to switch

Brain API (`src/brain`), per fighter:

```ts
new Brain({ ..., source: 'local' });   // 'jev' (default) | 'local' | 'house'
brain.setSource('house');              // hot swap between decisions
brain.source;                          // 'jev' | 'local' | 'house'
brain.linkStatus;                      // { kind: 'jev'|'local'|'house'|'offline', label }
```

`setSource` drops every answer still in flight from the old mind (it is never applied), aborts the old mind's running combination, and the new mind decides on the next frame. Both fighters share one JEV link and one LOCAL link (`sharedJevLink()`, `sharedLocalLink()`), so budgets and online/offline state are page-wide. The corner picker, the global override (PER CORNER / ALL JEV / ALL LOCAL / ALL HOUSE, never overriding YOU) and main.ts wiring belong to the integration build; it calls `setSource` or passes `source`.

HUD: `brain.latest.link` carries the status, and the MIND panel shows it. The chip reads `JEV · 265 ms`, `LOCAL · decider-4b · 480 ms`, `LOCAL · decider-4b · RULE` (an obvious tick settled by code), or `HOUSE`. The amber offline badge reads `JEV OFFLINE → HOUSE` or `LOCAL OFFLINE → HOUSE`. A HOUSE pick is a choice, not a fault, so it shows no offline badge.

## What to expect

- HOUSE: zero network calls (tested with counting fetches over 12 s of fight).
- LOCAL down (Ollama not running, model not pulled): the first request fails in milliseconds, the House Mind takes that decision, the badge turns to `LOCAL OFFLINE → HOUSE`, and `/api/local-jev/health` is probed every 3 s. The health probe is one tiny decision, so it also loads the model after a cold start. When it answers, the next frame asks the model again and the model takes over from any House Mind combination in progress.
- LOCAL too slow: a request over 3 s times out (bridge 504 at 3.0 s, browser gives up at 3.5 s); three answers in a row slower than 1.5 s also take the link offline to the House Mind until the next healthy probe.
- Latency: unmeasured on this Mac until the pull. Rough expectation for decider-4b Q4 on the M3 Max under the current build load is 0.5-1 s per full decision (the state, about 350 tokens, is evaluated once; the 13 other rows are short); decider-2b about half. Cloud Jev measures about 265 ms p50. The brain already tolerates this: slow answers whose situation changed are dropped as stale, and cadence stays at 1.5-4 Hz.
- Bridge overhead, measured against a mock Ollama on loopback (3 runs, 60 calls each): +1.5-1.6 ms p50 end to end over calling the runtime directly, of which 0.05 ms is the bridge's own work (JSON, prompt build, readout); the rest is the extra loopback HTTP hop.
- Quality: decider-4b is about 8 points below Jev on the JevBench hard tier. Expect a fighter that reads the fight less well than JEV and better than HOUSE; `COMPARE=1` above measures agreement on our own states.

## Tests

- `tests/server/local-mind.test.ts` (mock Ollama and mock native server on real ports): prompt layout, three question types, isolated levels, the temperature readout equals softmax(logits/T), >20 options, 400/422 validation, 504 timeout, concurrency cap and 429, runtime down and model missing, Ollama without logprobs, loopback-only guard (no fetch for non-loopback URLs), health, passthrough backend, env config, bridge latency.
- `tests/brain/local-source.test.ts`: default JEV never touches LOCAL, LOCAL uses only the local link, HOUSE makes no calls, LOCAL offline → House Mind with the badge, health re-probe every 3 s and recovery, too-slow fallback, hot swap with an answer in flight, a full brain → bridge → mock Ollama round trip, MIND panel labels.
- `tests/brain/live-local.ts`: the live check to run after the pull.
