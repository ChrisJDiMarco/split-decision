# UniMate reader: paper

**Headline:** UniMate is a 74M-parameter flow-matching transformer that outputs 2-second, 30 fps kinematic clips for any skeleton. It has no physics, no torque or joint limits and no contacts, it slides feet, and it needs about 1.2 s on an H100 per clip. That rules it out as a runtime skill layer in the browser. Its topology-encoding tricks are cheap and worth reusing: hop-distance and relation attention bias, sign-invariant Laplacian eigenvectors, an attention-pooled skeleton summary, and clamp-and-infill sampling.

## Key facts
- The output is kinematic only. Each clip is 60 frames (2 s at 30 fps) of 12-D per-joint features: 3 position, 6D rotation, 3 velocity. There are no torques, masses, joint limits, joint axes or contact model. Every joint is a 3-DOF rotation, so robot hinge joints need a projection onto the hinge axis plus limit clamping, and the motion must be tracked by a torque-clamped PD or learned controller at 500–1000 Hz.
- Physical plausibility is weak and admitted. The paper lists foot sliding, drift, hovering and ground penetration. The skate ratio on held-out legged rigs is 0.107, which falls to 0.023 only after IK foot-locking. No penetration, balance or dynamic-feasibility metric is reported. The only physics-like data filter is on root velocity and joint jitter, and it removed 8.7% of clips.
- Cost: the released model has 74.1M parameters, 10 layers of width 512 and 8 heads (the paper says 8 blocks). One clip takes about 1.2 s on an H100 with about 50 solver steps times 2 guidance passes. My rough estimate is 15 TFLOP per clip, which is seconds to a minute on consumer WebGPU. That fits build-time move-library generation, not a 20–50 Hz skill layer, and it is slower than Jev's 70–500 ms tier.
- Graph attention bias: a learned per-head scalar from an embedding of hop distance (clamped at 5 hops) plus an embedding of relation type (self, parent, child, sibling, none, end-effector). Each has 128-dim tables, a linear layer to the heads and a scale initialized at 0.02. It is added to the joint-attention logits, shared across frames, with separate tables per layer.
- Spec-RoPE: the 8 lowest nontrivial Laplacian eigenvectors per joint (the code uses the symmetric-normalized Laplacian, the paper says combinatorial D−A). A SignNet computes sum over sign (phi(u) + phi(-u)) per eigenvector, concatenates, and maps through rho to 32 rotary angles for the 64-dim heads. It handles sign flips but not basis ambiguity from repeated eigenvalues, which symmetric robot limbs produce.
- Global topology conditioner: 4 learnable queries cross-attend over the rest-pose skeleton tokens, followed by a feed-forward layer, a mean over queries, RMSNorm and a zero-initialized linear layer. The result is added to the timestep + mean-pooled FLAN-T5 text vector, and drives AdaLN-Zero in every sublayer. Removing it caused the largest quality drop (FID 0.757 to 0.825) plus jitter.
- All skeletons are rescaled to geodesic diameter 2.0, rotations are expressed relative to the rest pose, and velocities are normalized per frame. Absolute size and mass are gone, so a heavy and a light robot get the same timing. Moves need retiming to fit torque limits.
- Clamp-and-infill sampling is the most reusable trick. Pinning chosen frames or joints to x_t = (1-t)·noise + t·x1_known at each fixed Euler step allows in-betweening, joint-subset editing (for example legs locked while an arm strike is re-generated), and chaining clips from the actual current simulated pose.
- Combat content exists but is not quantified. The paper's prompt set includes 'combat', and the project's demo prompt file includes robot rigs doing 'A robot throws a punch forward.' and 'A robot kicks with one leg.', a human spin kick and high kick, and Unitree G1/Go2 and Spot rigs. No counts are given. The dataset is 84.1% bipedal and is not yet released.
- Practical barriers: inference only works for skeletons already processed into the dataset (sample.py skips unknown object types). A new robot needs the preprocessing pipeline: Blender bpy 4.0 (Python 3.10 only), LLM joint naming and facing-pair selection, and feature extraction. The environment is pinned to Python 3.10 with torch 2.5.1 for CUDA 12.4. Code is MIT, but the weights were trained on Truebones, Mixamo and Objaverse data under their own licenses, so commercial use is unclear.

## Summary

UniMate generates **kinematic** motion only: joint rotations, positions and velocities for any rigged skeleton, from a text prompt. Sources: paper https://arxiv.org/abs/2609.05415, full text https://arxiv.org/html/2609.05415v1, code https://github.com/Friedrich-M/UniMate, weights https://huggingface.co/Linzhan/UniMate.

- **What it lacks for physics.** No masses, torques, joint limits, joint axes or contact model. The paper says it can produce foot sliding, drift, hovering and ground penetration.
- **Runtime cost.** Sampling uses about 50 solver steps times 2 passes for classifier-free guidance, on a 74.1M-parameter denoiser. A 2 s clip takes about 1.2 s on an H100.
- **Fit with the browser-only plan.** Chris's latest direction is: no NVIDIA, runs in anyone's browser, Jev only picks tactics. Under that plan the model itself is not a runtime component. Its skeleton-encoding ideas are the reusable part.
- **Paper vs. released code.** The two disagree in several places (table at the end). Where they differ, the code and model card describe the weights you would actually load.

---

## 1. Motion representation

**Paper (Sec. 3.1).** Each joint has 12 features: 3D position, 6D rotation and 3D velocity.
- Non-root positions: horizontal (x, z) relative to the root, rotated into the root's facing frame; height (y) kept in world frame.
- The paper says the root "retains its global position" and that velocity is "in the world frame."
- Rotations are expressed relative to the rest pose.
- Motions are placed y-up, with the initial root at the origin and initial facing along +z. Facing is estimated from a left/right symmetric joint pair.
- Normalization uses separate statistics for root features and non-root features.

**Released code** (`unimate/utils/motion_utils.py`) works differently, and matches the paper's own Appendix B.6:
- Root slot: position = [0, height, 0]; the 6D channels hold the facing quaternion; velocity = [xz velocity in the facing frame, y velocity].
- The xz trajectory is recovered by integrating that root velocity.
- Per-joint velocities are rotated into the root-facing frame, not the world frame.
- Rotations follow the HumanML3D convention: each joint's slot holds the rotation of the bone from its parent to itself.

**Frame rate and clip length.**
- Frames are resampled to 30 FPS for rendering and evaluation (Appendix A.4 / E.5).
- The feature code (`data_process/utils/motion_features.py`) only halves sources at 60 fps or above until they drop below 60. A 24 or 50 fps source would keep its native rate. I cannot tell whether any such sources are in the data.
- Clips are 60 frames (`max_motion_length: 60`). The model card says "60-frame clips (2 seconds at 30 fps)."
- The paper also shows a 180-frame long-horizon variant (Fig. 8). Only 60-frame checkpoints are released.

**Scale.** The paper normalizes by topology diameter (Eq. 2). The code scales the bone-length-weighted leaf-to-leaf geodesic diameter to 2.0 (`target_diameter=2.0`).

## 2. Flow-matching setup

**Paper.**
- Conditional flow matching with a linear path. The network predicts the velocity field v = x1 − x0.
- Training time is sampled uniformly, τ ~ U(0,1).
- Loss = masked MSE + 0.5 × geodesic SO(3) loss on the one-step-denoised rotations (x̂1 = xτ + (1−τ)v) + 0.1 × smoothness penalty on the denoised velocity channels (Eqs. 15, 18–20).
- Inference: a 50-step fixed Euler solver with guidance scale s = 3.0 (Eq. 22). The text condition is dropped with probability 0.1 during training.

**Released code** (`models/flow/transport.py` and `path.py`, adapted from SiT):
- The linear path and uniform time sampling match the paper.
- But `generate.py` calls `sample_ode()` with its defaults: **dopri5 adaptive** (atol 1e-6, rtol 1e-3). The code's own docstring in `motion_inbetweening.py` says plain text sampling uses dopri5. Only in-betweening, editing and expansion use 50-step fixed Euler.
- Guidance runs the conditional and unconditional passes as two separate forward calls; the paper says they are batched.
- With AdaLN text conditioning, the unconditional branch is a zeroed text vector, not the "learnable null embedding" the paper describes.

## 3. Transformer layout

**Paper.** 8 blocks, width d = 512, 8 heads (head dim 64), SwiGLU feed-forward with nominal size 4d = 2048, RMSNorm and query-key norm. Each block does: joint attention within each frame, then temporal attention per joint (1D RoPE over frame index), then the feed-forward layer (Eq. 8).

**Released code and weights.**
- `num_layers: 10` in the repo config and in the v2 config on Hugging Face.
- The model card lists **74.1M parameters** for both the preview and v2 checkpoints.
- The SwiGLU hidden size is actually int(2/3 × 2048) = 1365 (`blocks/graph.py`).
- Each block's AdaLN-Zero produces 9 × 512 modulation values (shift, scale, gate for each of the 3 sublayers).

**Tokens.**
- The rest pose is prepended as frame 0, giving (T+1) × J tokens.
- Skeleton tokens: an MLP of the joint's rest position concatenated with its parent's, then a fusion MLP. The root has its own embedder.
- Motion tokens: MLP(m) + depth embedding + a joint-name embedding. The name embedding is the FLAN-T5 embedding of a standardized anatomical name, passed through a linear layer (`base.py`).
- Output head: separate MLPs for the root and for other joints. The root token first cross-attends to that frame's joints; this cross-attention is zero-initialized.
- Limits: up to 71 joint slots (v2 supports 5–70 joints); maximum tree depth 19.

## 4. The three topology mechanisms: exact math

### (a) Graph-aware attention bias (Graphormer-style)

- Paper (Eqs. 9–11): B_ij^(h) = w_d^(h)ᵀ E_d(G_ij) + w_r^(h)ᵀ E_r(R_ij). This bias is added to the joint-attention logit after the Spec-RoPE rotation. It is shared across frames. Embedding size d_e = 128.
- Code (`blocks/graph.py`, `utils/topology_utils.py`):
  - Each table is embedding(dim/4 = 128) → Linear(→ heads) × a learnable scale initialized to 0.02, for both distance and relation.
  - Padded joints are masked to −inf.
  - Each layer has its own tables by default.
- **Distance** = unweighted hop count found by breadth-first search, **clamped at 5 hops** (not stated in the paper).
- **Relation types**: self, parent, child, sibling, no_relation, end_effector (leaf joints, set on the diagonal). The paper mentions "ancestor"; the code has no ancestor type.
- The softmax is computed in fp32.

### (b) Spec-RoPE

- The paper defines the combinatorial Laplacian L = diag(A1) − A, drops u0, and uses the first m = 8 nontrivial eigenvectors per joint (Eqs. 3, 12–13).
- **The code instead defaults to the symmetric-normalized Laplacian `laplacian_norm='sym'` with L2-normalized eigenvectors.** This comes from `np.linalg.eigh`. Skeletons with fewer than 9 joints get zero-padded.
- Angles are computed with SignNet: θ_j = ρ(concat_k [φ(u_k(j)) + φ(−u_k(j))]).
  - φ: 1 → 64 → 64 with GELU.
  - ρ: 8·64 → 64 → d_h/2 = 32 angles. Each angle is duplicated to rotate the 64-dim query and key vectors.
- This is invariant to each eigenvector's sign flipping. It is **not** invariant to rotations of the basis within repeated eigenvalues. The paper admits this for repeated or near-repeated eigenvalues and for a cut that falls inside one (Appendix C.3). Symmetric limbs on a robot create exactly those repeated eigenvalues. The paper's defence: the distance/relation bias, name and depth embeddings, and rest-pose geometry are unaffected by the basis choice.
- Theory in Appendix C covers the linear-angle case: relative-coordinate invariance, permutation equivariance, reduction to 1D RoPE on a path graph, and an effective-resistance interpretation. It does not formally hold for the SignNet version.
- A WIRE linear-frequency backend exists as an ablation.

### (c) Global topological conditioner

- Paper Eq. 14: n_q = 4 learnable queries cross-attend over the skeleton tokens. The outputs are mean-pooled into c_topo. Then c = c_τ + c_text + c_topo drives AdaLN-Zero in every sublayer and the output head (Eq. 17).
- Code (`TposCrossAttentionPool`):
  - Pre-norm 4-head cross-attention with a residual connection, then a SwiGLU feed-forward with a residual.
  - Mean over the 4 queries → RMSNorm → a zero-initialized linear layer, added to y.

**Ablations** on unseen Truebones skeletons (FID / diversity):

| Variant | FID | Diversity |
|---|---|---|
| Full model | 0.757 | 9.200 |
| No graph bias | 0.773 | 8.799 |
| No Spec-RoPE | 0.798 | 8.424 |
| No conditioner | 0.825 | 9.475 |

Without the conditioner the motion becomes jittery and poorly grounded. Other curation effects:
- Dropping rest-pose rotation rebasing raises FID to 1.179.
- Dropping augmentation lowers diversity to 8.265.

## 5. Text conditioning

- Frozen FLAN-T5-Base encoder.
- In the released AdaLN variant, the prompt enters as a **single mean-pooled token vector** projected 768 → 512 (`_encode_prompt`, `_build_adaln_y`). A cross-attention variant (`full_cross_attn`) also exists.
- Joint names are embedded with the same encoder.

## 6. Training compute

| Source | GPUs | Steps | Batch | Time |
|---|---|---|---|---|
| Paper | 8×H100, bf16 | 100k | 256 global | ~1 day |
| Model card, v2 | 8×H100 | 100k | 16 per GPU | ~22 h |
| Model card, preview | 6×H100 | 120k | not stated | ~23 h |

- Optimizer: AdamW, learning rate 1e-4, betas (0.9, 0.99), weight decay 1e-5, gradient clipping at 1.0, cosine schedule with 3% warmup and a 5% floor. EMA decay is min(0.9999, (1+n)/(10+n)).
- Checkpoint files are 1.19 GB each. My inference: that is weights + EMA copy + Adam state; inference-only weights would be about 300 MB fp32 / 150 MB fp16.

## 7. UniML3D dataset

**Size and sources (Appendix A.1).**
- 13,006 sequences, 2,140,232 frames.
- Truebones: 1,094 animal sequences over 74 skeletons.
- Mixamo: 2,425 human sequences.
- Objaverse-XL: 9,487 sequences from 6,965 assets with rigs and animation.
- 84.1% bipedal; marine 0.8%; serpentine 0.3%. Joint count median 38, mean 40.4.
- Model card v2 per-source shares: Truebones 13%, Mixamo 24%, Objaverse 63%. These differ from the raw sequence counts, so they are probably sampling weights after rebalancing (my inference).

**Filtering.**
- Keep the tree with the largest skinning weight.
- Realign the root.
- Remove zero-weight helper or IK bones.
- Drop static clips.
- An "implausibility" filter on root velocity and per-joint angular jitter removed 8.7% of clips.

**Canonicalization.**
- Joints ordered by breadth-first search from the root.
- Scaled by the diameter.
- y-up; facing +z from a symmetric pair that an LLM picks.
- Rotations expressed relative to the rest pose.

**Annotation.**
- Joint names standardized to a fixed anatomical vocabulary by DeepSeek-V4-Flash, with optional GPT-5 refinement.
- Captions come from Qwen3.5-9B on 4-view renders, followed by a manual quality pass. There are 3,584 unique prompts.

**Augmentation and sampling.** Joint removal, joint insertion, skeleton pooling and bone-length perturbation; sampling weight ∝ n^−0.5 per skeleton type.

**Combat content.**
- The paper says the prompts cover "locomotion, combat, idle…" but gives **no count**.
- The held-out evaluation prompts include attacks, lunges and pounces.
- The project demo's prompt file (https://linzhanmou.com/unimate/resources/prompts.json) includes:
  - robot rigs: "A robot throws a punch forward.", "A robot kicks with one leg.", "A robot punches forward."
  - "A human performs a spin kick."
  - Unitree G1 and Go2 and Boston Dynamics Spot rigs doing walk, jump and rear-up.
- The README says the dataset is still "being prepared for open release" and that captions were re-processed.

## 8. Evaluation

**Motion generation vs. AnyTop.**
- AnyTop is the closest prior method; the authors added text cross-attention to it for this comparison.
- **Both models were trained and tested on Truebones only.** Held out: 7 skeletons, 58 prompts, seed 10.
- FID over kinematic features: 0.757 vs 2.711. Diversity (average pairwise joint distance over 5 samples): 9.200 vs 8.139.

**Mesh animation vs. AnimateAnyMesh and V2M4.** 18 meshes scored with VBench, plus a 32-person user study.
- UniMate: OC 0.186, DD 0.833, AQ 0.544, 1.214 s per mesh.
- AnimateAnyMesh: 15.5 s per mesh.
- V2M4: 1.64 h per mesh.
- User study average: 4.615 vs 2.808 and 2.413.

**Not compared** (no code released): How to Move Your Dragon, AnimaX.

**Physics-related metrics.**
- There are no penetration, joint-limit, balance or dynamic-feasibility metrics.
- Only foot sliding is measured (Appendix E.5): 20 held-out legged rigs, 30 fps.
  - Skate ratio: 0.107 raw → 0.023 after IK foot-locking.
  - Slide: 0.542 → 0.191 (×10⁻² of root height).
- The foot lock works like this:
  1. Detect contact frames.
  2. Median-filter the contact signal over 5 frames and drop segments shorter than 3 frames.
  3. Anchor each contact segment at its mean position.
  4. Pin the foot with damped least-squares IK over up to 3 parent joints.
  5. Blend the correction in and out over 5 frames.

## 9. Speed

- About 1.2 s per 60-frame clip on one H100, including T5 and forward kinematics (Appendix B.6). The paper's "inference runs at 50 FPS" is just 60 frames ÷ 1.2 s, i.e. generation throughput. It is not a control rate.
- Editing is described as "interactive rates" but is not quantified.

**Browser cost (my rough estimate, not from the paper).**
- About 42M parameters touch each token per layer stack. A 30-joint skeleton has 61 × 30 tokens, so one forward pass is about 0.15 TFLOP.
- 50 steps × 2 guidance passes ≈ 15 TFLOP per 2 s clip. On consumer WebGPU that is roughly several seconds to over a minute.
- Fine for generating a move library when a build is finished. Far too slow for a 20–50 Hz skill layer.
- T5 can be skipped entirely if the skill prompts are a fixed, precomputed set.

## 10. Stated limitations

- Foot sliding, drift, hovering and ground penetration, because there is no unified contact model.
- Rare topologies can come out static, jittery or wrong.
- Data is dominated by humanoids.
- Conditioning is only skeleton + text; there is "no native channel for fine-grained spatial motion control."
- Complex social interactions are hard, and there is no multi-character modeling.
- Symmetric-eigenspace ambiguity in Spec-RoPE (Appendix C).
- The model card adds: fixed 60 frames, at most 70 joints, and "Skeletons require data pipeline processing."
- In code, `sample.py` skips any object type not in the loaded dataset. A new robot must first be run through the preprocessing pipeline: Blender (`bpy==4.0.0`, which only has Python 3.10 wheels), LLM joint naming, and feature extraction. The pinned environment is Python 3.10 with torch 2.5.1 built for CUDA 12.4. Apple MPS or CPU support is not mentioned (untested).

## 11. What matters for torque-limited simulated robots (my inference unless cited)

1. **Joint model mismatch.** Every joint is represented as a full 3-DOF 6D rotation. Robot hinge joints need a swing-twist projection onto the hinge axis, plus clamping to joint limits the model never saw.
2. **No dynamics.** The training data is artist animation; the only physics filter is on velocity and jitter. The root is a free floating base. Generated kicks and jumps may need impossible torques or break balance. You would need a torque-clamped PD tracker at 500–1000 Hz, which is about 17–33 physics steps per motion frame, or an imitation-learned tracker. Even then, expect falls.
3. **Scale is erased.** Everything is normalized to diameter 2.0, and velocities are per-frame in normalized units. A heavy robot and a light one get the same timing. Moves need time-scaling for mass and torque limits.
4. **Use rotations, not positions.** Positions and rotations are predicted redundantly and can disagree. The repo renders both an `_fk` and a `_ric` recovery. Driving the robot from the rotations plus forward kinematics keeps bone lengths correct.
5. **Clamp-and-infill is the most reusable sampling trick.** Holding frames or joints fixed during integration lets you start the next clip from the *actual simulated pose*, or lock the legs while re-generating an arm strike.
6. **Cheap, portable skeleton descriptors.** All of these are cheap to compute in TypeScript for 70 joints or fewer, and could condition a small procedural or learned skill layer that generalizes across builds:
   - breadth-first joint order
   - the 6 relation types and hop distance clamped at 5
   - joint depth
   - 8 Laplacian eigenvectors
   - SignNet-style sign invariance
   - a symmetric joint pair to define facing
   - contact joints found by name (Foot, Toe, Paw, Hoof…)
7. **Licensing.** The code is MIT. The weights were trained on data under Truebones commercial terms, Mixamo terms and per-object Objaverse licenses, so commercial use of the weights is unclear.

## Paper vs. released code

| Item | Paper | Code / model card |
|---|---|---|
| Blocks | 8 | 10 (74.1M parameters) |
| Laplacian | combinatorial D−A | symmetric-normalized, L2-normalized eigenvectors |
| Relation types | includes "ancestor" | self/parent/child/sibling/none/end-effector; hops clamped at 5 |
| Sampler | 50-step Euler | dopri5 adaptive for text sampling; Euler only for editing |
| Guidance null | learnable embedding | zero vector (AdaLN path) |
| Velocity frame | world frame | root-facing frame |
| Batch | 256 global | 16 per GPU |
| Joint limit | not stated | 60 (preview) / 70 (v2) |

## Unknowns
- How many UniML3D clips are fighting or combat motions (punch, kick, block, clinch, get-up). The paper gives no counts, the dataset is unreleased, and captions were re-processed for the release.
- The real frame-rate mix of the training data. The paper says 30 FPS, but the code only halves sources at 60 fps or above, so 24 or 50 fps sources may keep their native rate.
- How many function evaluations the default dopri5 sampler (atol 1e-6, rtol 1e-3) actually uses, and whether the paper's 1.2 s H100 timing used dopri5 or 50-step Euler.
- Whether the model runs on Apple MPS, on CPU, or exported to ONNX / WebGPU without changes. The model code uses standard PyTorch ops, but the configs set device 'cuda' and the environment is CUDA-pinned. Untested.
- Quality with fewer sampling steps or without guidance (for example 4–10 Euler steps). No few-step or distilled results are reported; this decides browser feasibility.
- How it behaves on robot-style rigs with mostly 1-DOF hinges, non-anatomical joint names (which fall back to 'Bone' or 'Appendage'), or bilaterally symmetric builds whose repeated Laplacian eigenvalues make Spec-RoPE ambiguous. The demo shows G1, Go2, Spot and 'Gundam' rigs, but there is no quantitative evaluation on robots.
- Whether the paper's Table 1 and ablation numbers come from a Truebones-only model rather than the full UniML3D model. The text says both models were trained and evaluated on Truebones, but it is not stated explicitly for the ablations.
- What license covers the released weights for commercial game use, given Truebones commercial terms, Mixamo terms and per-object Objaverse licenses.
- Whether the 180-frame long-horizon variant or the text-cross-attention variant will be released. Only 60-frame AdaLN graph checkpoints (preview and v2) are on Hugging Face now.
- Parameter count of the frozen FLAN-T5-Base encoder part (about 110M by my general knowledge, not stated in the paper). It only matters if prompts are not precomputed.