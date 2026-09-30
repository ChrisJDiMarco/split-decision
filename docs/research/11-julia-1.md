# Julia 1: can JEV KUNE DO use it? (2026-09-29)

Verdict: **try it, with an adapter and our own eval first.** Workflow wf_d3fbc843-956 (three searches and an adversarial assessor).

## What it is
- **Base model: SupersonicLabs/Julia-1** ([HF](https://huggingface.co/SupersonicLabs/Julia-1)).
  - From Supersonic Labs, a small lab in Brazil. Repo created 2026-09-23, announced 2026-09-26.
  - Apache 2.0.
  - A 144.3M-parameter encoder (mmBERT-small / ModernBERT) with a decision head that scores the options you give it. Not a chat model.
  - Question types: choice (2-20 options, 48 tokens each), score (expected level index) and noul (P(true)), each with full softmax probabilities.
  - Context is 8,192 tokens, but question plus options must fit in about 512.
- **Cris Lenta's post (the 61% → 95%)** is his LifeSim team's own fine-tune for NPC "system 1" decisions ([post](https://x.com/crislenta/status/2104959891832283331)).
  - Measured on a private benchmark nobody has described.
  - Those weights are not public ("more soon").

## Fit for us
- **Protocol.** Not /v1/systemone natively. Two community servers wrap it: [julia-1-api-server](https://github.com/ianrodrigues/julia-1-api-server) and [julia-system-one](https://github.com/italoalmeida0/julia-system-one). A browser adapter is small: criteria → options, choice → argmax + probabilities, score → expected index, noul → P(true).
- **Browser.**
  - Official [Julia-1-ONNX](https://huggingface.co/SupersonicLabs/Julia-1-ONNX) on ONNX Runtime WebGPU: about 75 ms per decision.
  - Through Transformers.js ([open-jev PR #2](https://github.com/nico-martin/open-jev/pull/2), not merged): about 16 ms on an M3 Pro, with a WASM fallback. It needs a whitespace-tokeniser fix.
  - First load is 551 MB FP32 plus a 34 MB tokenizer; no quantised browser build exists yet.
- **On the Mac.** No Ollama or stock llama.cpp. Use the Python runtime (about 33 ms on an M4 CPU), the community MLX port or a community server.
- **Quality.** Independent Decision Index 0.2.1 ([index.json](https://huggingface.co/spaces/multimodalart/jev-decision-index/raw/main/data/index.json)): rank 61 of 70, skill 5.54.
  - For comparison: Jev 57.91, Mapika Decider 4B 40.7, Decider 2B 28.97, Kev 0.8B 14.6.
  - Badly overconfident: ECE 0.42 against about 0.08 for the others. Its own calibration file is null.
  - Simple game control works on Supersonic's tests (vizdoom 97%, platformer 91%, snake 79%). Lookahead is poor (tic-tac-toe 41%).
- **Terms.** Running Apache weights isn't distilling Jev. Fine-tuning on our own data is allowed as long as the labels aren't Jev outputs. Physics outcomes (did the tactic land, damage over 2 s) and House Mind decisions both qualify; House Mind is rule-based (src/brain/house-mind.ts), not Jev-backed. Supersonic's training data is undisclosed; worth asking them.

## Plan if we use it
1. Put a LOCAL · JULIA in-browser option behind the mind picker. Keep tactic option text short: at most 48 tokens each, about 512 in total.
2. Run an offline eval first: about 500 fight states from non-Jev self-play, labelled by physics outcomes. Compare Julia, Decider 2B and Kev 0.8B on accuracy, ECE and latency on Chris's Mac.
3. Temperature-scale probabilities per question type before they reach the HUD.
4. Measure GPU headroom next to MuJoCo and three.js. Cache the 551 MB model (Cache API or OPFS) behind a progress bar.
5. Only if the eval says so: fine-tune the head plus the last 1-2 layers on outcome-labelled states.

The download needs Chris's OK.
