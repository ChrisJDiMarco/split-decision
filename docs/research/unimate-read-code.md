# UniMate reader: code

**Headline:** UniMate's code is MIT and easy to port: it has no CUDA-only kernels, and the three topology mechanisms add up to about 300 lines. It can't be used as-is for a browser game. Its 74M-parameter flow model needs roughly 5–40 TFLOPs per 2-second clip, custom skeletons have to go through the dataset pipeline, the output is kinematic and not physically feasible, and the weights have no explicit license.

## Key facts
- The code is MIT (Copyright 2026 Linzhan Mou). The HF model card has no license field for the weights. It says the training data stays under its source licenses: Adobe Mixamo terms, per-object Objaverse-XL licenses, and the commercial Truebones pack, which cannot be redistributed. Treat the weights and the clips they generate as legally unclear for a commercial game. Porting the MIT code is clean.
- Everything is already released. The UniML3D dataset has been public since 2026-08-30: 53.4 GB, 13,769 clips, not gated, but with the Truebones motion files excluded. Two weight sets are out: v2 (recommended, 5–70 joints, 100k steps, 74.1M params) and a superseded preview. Each checkpoint_step_*.pt is about 1.186 GB. That is roughly 4x the 296 MB fp32 weights, which suggests the file also holds EMA and Adam state. Inference-only weights would be about 296 MB fp32, 150 MB fp16, or 75 MB int8 (my estimates).
- The model is a flow-matching transformer with linear path and velocity prediction: 10 layers, width 512, 8 heads. Spatial attention runs per frame and temporal attention per joint, with AdaLN text conditioning, CFG 3.0 and 60 frames at 30 fps (2 s). By default, generate.py calls sample_ode(), which uses adaptive dopri5 (atol 1e-6, rtol 1e-3). The paper instead says fixed-step Euler and gives no step count.
- The three mechanisms are in these files. Graph attention bias: blocks/graph.py (build_graph_bias_params, compute_graph_bias, SpatialGraphSelfAttention). Spectral RoPE: rope.py (SpectralJointRoPE.forward_per_frame, SignNetSpectralEncoder) plus topology_utils.compute_laplacian_eigenvectors (symmetric-normalized Laplacian, first 8 non-trivial eigenvectors). Global conditioner: blocks/common.py (TposCrossAttentionPool, with 4 queries), added to the AdaLN vector in graph_adaln.py. All three depend only on the skeleton, so they can be computed once per robot build.
- A robot's parent array plus rest offsets is enough in principle. It must be BFS-ordered, Y-up, facing +Z, scaled so the bone-length-weighted leaf-to-leaf diameter equals 2.0, and grounded. It also needs a 768-d flan-T5 embedding per joint name, a left/right facing pair, depth of 19 or less, at most 70 joints, and the root/local mean and std from dataset_stats.npy. The shipped sample.py only animates object types already in the processed dataset. The practical route is our own ~100-line conditioning builder.
- Output is (F, J, 12) per joint, denormalized: RIFKE position (3), 6D rotation (6) and velocity (3) in the facing frame. Rotations are relative to the T-pose and HML-reordered, so joint j stores its parent's local rotation. Leaf rotations are never generated, and for branching parents the last child's copy wins. The root slot holds only facing plus height, and XZ comes from integrating velocity. If the robot's rest pose has identity local rotations, the decoded quaternions are directly local rotations relative to rest. Hinge angles then come from swing-twist projection. The motion is kinematic and ignores torque, balance and contacts, and the paper itself admits foot sliding.
- Apple Silicon: I found no xformers, flash-attn, pytorch3d or custom CUDA kernels in the model code. The blockers are the requirements.txt pins (torch 2.5.1+cu124 from the CUDA index, bpy 4.0.0, Python 3.10), config.json setting device to cuda, and torchdiffeq dopri5, which may hit MPS's lack of float64 (not verified; switching to Euler or running on CPU avoids it). torch-geometric is only used for get_laplacian. MPS or CPU inference looks feasible after small patches.
- Browser feasibility (my FLOP estimates, not measured). One forward pass costs about 105 GFLOPs at 20 joints and about 375 GFLOPs at 71 padded joints. A clip with CFG and 25–50 Euler steps is about 5–40 TFLOPs. In a browser via ONNX Runtime Web on WebGPU that is about 2–15 s per clip on an M3 Max and about 5–75 s on a typical laptop iGPU. It can't run per Jev decision. At best it could generate a move library once, when a build is finalized.
- You can drop the text encoder. graph_adaln reads only a pooled 768-d caption vector (the masked mean of flan-T5 encoder states; unconditional is a zero vector) and one pooled 768-d vector per joint name. Precompute one vector per move plus a fixed joint-name vocabulary (about 1 MB) and ship only the denoiser. The vocabulary is biological, so robot parts should be mapped to anatomical names.

## Bottom line

UniMate is real, released and permissively licensed at the code level. Its three topology ideas are small, clean PyTorch that can be ported to TypeScript in a day or two. As a runtime component in a browser game that anyone can play, it has four problems:

1. **Cost.** It is a 74.1M-parameter flow model. By my estimates below, a 2-second clip costs about 5–40 TFLOPs, which is seconds to over a minute per clip on laptops.
2. **No custom-skeleton entry point.** The shipped inference path only animates skeletons that already went through its dataset pipeline.
3. **Kinematic output.** It generates motion only and ignores torque limits, balance and contact.
4. **Weights license.** The weights carry no explicit license and were trained partly on commercial and per-object-licensed data.

The best fit for Chris's browser-only plan, where Jev is just the controls:
- **Port the topology featurization.** Laplacian spectral coordinates, graph-distance and relation matrices, and a pooled skeleton code, all as deterministic JS computed once per robot build.
- **Optionally run UniMate offline on the M3 Max** to make reference clips for a handful of canonical body plans.
- **Don't put it in the decision loop.**

---

## 1. What is actually released (checked 2026-09-29)

| Item | Status | Source |
|---|---|---|
| Training and inference code | Released 2026-09-06. Includes in-betweening, joint editing, motion expansion, and a five-stage data pipeline | [README](https://github.com/Friedrich-M/UniMate) |
| Weights | [HF Linzhan/UniMate](https://huggingface.co/Linzhan/UniMate). Two runs: **`unimate_uniml3d_f60_v2`** (recommended; data release 2026-09-27; 5–70 joints; 100k steps; 74.1M params) and **`unimate_uniml3d_f60_preview`** (superseded; 5–60 joints; 120k steps) | [model card](https://huggingface.co/Linzhan/UniMate/raw/main/README.md), [file tree](https://huggingface.co/api/models/Linzhan/UniMate/tree/main?recursive=true) |
| Checkpoint files | Only `checkpoint_step_*.pt`, each about **1,185,825,837 bytes**. v2 has 10 of them (10k–100k steps). Each run also ships `config.json`, `dataset_stats.npy` (1,934 B) and TensorBoard logs. No safetensors, ONNX or Core ML | same |
| Dataset | **Already public, not gated**, since 2026-08-30: [UniML3D](https://huggingface.co/datasets/Linzhan/UniML3D), 53.4 GB, 13,769 clips (the paper says 13,006, so the set has grown). **Truebones motion files are excluded**: you buy the pack and rebuild them | dataset card |
| Still in motion | The card says UniML3D is "actively maintained" and captions and annotations change between releases. The README says the weights get ongoing updates. The interactive demo looks like a GLB viewer, but I could not confirm whether it runs live inference | [project page](https://linzhanmou.com/unimate/) |

The task brief said the dataset is "being prepared". That is out of date.

**Checkpoint size (my inference).** 74.1M params × 4 bytes = 296 MB, and 4 × 296 MB is about 1.186 GB. So each .pt most likely holds model weights, EMA weights and two Adam moment buffers. Inference needs only the EMA weights, which the sampler loads when present: about 296 MB in fp32, about 150 MB in fp16, about 75 MB with int8 weights. The 74.1M figure covers the denoiser only. My per-block arithmetic gives about 6.6M × 10 layers plus I/O layers, which is about 74M. flan-t5-base is separate: [~0.25B total](https://huggingface.co/google/flan-t5-base), of which the encoder is roughly half.

## 2. Licenses and third-party constraints

- **Code:** MIT, "Copyright (c) 2026 Linzhan Mou" ([LICENSE](https://raw.githubusercontent.com/Friedrich-M/UniMate/main/LICENSE)). Porting the topology modules into our codebase is clean as long as we keep the notice.
- **Weights:** the HF front matter has **no `license:` field**. The card only says the code is MIT and that the training data "remain governed by the licenses of their original sources": Adobe's Mixamo terms, per-object Objaverse-XL licenses, and the Truebones ZOO commercial license. Nothing explicitly licenses the weights or what they generate. For a commercial game, ask the authors or don't ship the weights and their outputs.
- **Objaverse-XL assets** keep "their individual upstream licences, which are heterogeneous" ([card](https://huggingface.co/datasets/Linzhan/Objaverse-XL-Rigged-Animated)). I did not verify what share is non-commercial.
- **Annotations** (captions, joint labels, facing pairs, categories) are ODC-BY 1.0.
- **flan-t5-base** is Apache-2.0 ([HF](https://huggingface.co/google/flan-t5-base)).
- **`Motion` library** ([inbar-2344/Motion](https://github.com/inbar-2344/Motion)): a pure NumPy fork of Holden's Animation and Quaternions code, used for FK and rotation decoding. The page shows no license, so I couldn't verify it.

## 3. Architecture as configured (v2 [config.json](https://huggingface.co/Linzhan/UniMate/raw/main/unimate_uniml3d_f60_v2/config.json))

- **Transformer:** `attention: graph`, `text_cond: adaln`, `latent_dim 512`, `ff_size 2048` (SwiGLU hidden int(2/3·2048)=1365), `num_layers 10`, `num_heads 8`.
- **Positional encoding:** `use_spectral_rope true`, `max_freqs 8`, `use_signnet true`.
- **Topology inputs:** `use_joint_name_emb true`, `use_depth_emb true` (`max_depth 19`), `concat_parent_features true`, `num_tpos_queries 4`, `inject_tpos_to_adaln true`, `share_graph_attn_bias false`.
- **Limits:** `max_joints 71`, `max_motion_length 60`, `feature_len 12`.
- **Sampling:** `cfg_scale 3.0`, `cond_mask_prob 0.1`, and `"device": "cuda"` in the sampling block.
- **Training:** `diff_model: "flow"`, 8×H100 for about 22 h.
- **Flow model:** linear path with velocity prediction, adapted from SiT ([integrators.py](https://raw.githubusercontent.com/Friedrich-M/UniMate/main/unimate/models/flow/integrators.py), [transport.py](https://raw.githubusercontent.com/Friedrich-M/UniMate/main/unimate/models/flow/transport.py)).
- **Solver:** [generate.py](https://raw.githubusercontent.com/Friedrich-M/UniMate/main/unimate/inference/generate.py) calls `gen_diffusion.sample_ode()` with no arguments, so it gets **`sampling_method="dopri5"` (adaptive), `num_steps=50` saved points, `atol=1e-6`, `rtol=1e-3`**. The [paper](https://arxiv.org/html/2609.05415) says it uses a "fixed-step Euler solver" and gives no step count. So code and paper disagree, and the real number of forward passes (NFE) is unknown.
- **CFG** runs the model twice per evaluation.
- **Runtime claim:** the paper reports "50 FPS" and 1.214 s in its Table 2. That matches 60 frames in about 1.2 s, but I found no statement of which GPU was used.

## 4. Where the three topology mechanisms live (port map)

All excerpts below are from the MIT-licensed repo.

**(1) Graph-aware attention bias.** Code: [`unimate/models/denoiser/blocks/graph.py`](https://raw.githubusercontent.com/Friedrich-M/UniMate/main/unimate/models/denoiser/blocks/graph.py), functions `build_graph_bias_params`, `compute_graph_bias` and class `GraphAttnBias`, used in `SpatialGraphSelfAttention.forward`.

- **Inputs** come from [`unimate/utils/topology_utils.py::compute_edge_relations_and_distances`](https://raw.githubusercontent.com/Friedrich-M/UniMate/main/unimate/utils/topology_utils.py).
- **Relation types:** `EDGE_TYPES`: self 0, parent 1, child 2, sibling 3, no_relation 4, end_effector 5. End effector is the self-slot of a leaf.
- **Distances:** BFS hop distance clamped at `max_path_len=5`. The hop count is unweighted, even though the paper calls it geodesic.
- **Parameters:** each of the 10 layers has its own tables.

```python
def compute_graph_bias(module, cond, attention_mask):
    dist_emb = module.graph_dist_proj(
        module.graph_dist_embedding(cond["graph_dist"])) * module.graph_dist_scale
    rel_emb = module.graph_rel_proj(
        module.graph_rel_embedding(cond["joint_relations"])) * module.graph_rel_scale
    graph_bias = (dist_emb + rel_emb).permute(0, 3, 1, 2)   # (B,H,J,J)
    return graph_bias.masked_fill(~attention_mask.to(torch.bool), float('-inf'))
```

This is added to `q@kᵀ·scale` before softmax, using an explicit matmul rather than SDPA.

**(2) Spectral RoPE.** Code: [`unimate/models/denoiser/rope.py`](https://raw.githubusercontent.com/Friedrich-M/UniMate/main/unimate/models/denoiser/rope.py), classes `SpectralJointRoPE` (with `forward_per_frame`) and `SignNetSpectralEncoder`, plus function `_apply_rotary_pos_emb`.

- **Eigenvectors** come from `topology_utils.compute_laplacian_eigenvectors`. It builds a symmetric-normalized Laplacian with PyG `get_laplacian`, runs `np.linalg.eigh`, drops the trivial eigenvector, keeps the next 8, L2-normalizes them and zero-pads when J−1 < 8.
- **SignNet** maps these to head_dim/2 = 32 angles, which are duplicated and applied as standard rotate-half RoPE to q and k in spatial attention.
- **Temporal attention** uses ordinary 1-D RoPE over frame indices.

```python
def forward(self, spectral_coords):          # SignNetSpectralEncoder
    v = spectral_coords.unsqueeze(-1)        # (B,J,8,1)
    h = self.phi(v) + self.phi(-v)           # sign-invariant
    return self.rho(h.flatten(start_dim=-2)) # (B,J,32) rotation angles
```

**(3) Global topological conditioner.** Code: [`unimate/models/denoiser/blocks/common.py`](https://raw.githubusercontent.com/Friedrich-M/UniMate/main/unimate/models/denoiser/blocks/common.py), classes `TposPool` and `TposCrossAttentionPool`.

- **Per-joint input:** each joint's rest-pose token comes from `InputLayer`. It fuses the joint's own T-pose feature with its parent's.
- **Pooling:** 4 learned queries cross-attend over the joint tokens and the result is mean-pooled.
- **Injection:** in [`graph_adaln.py`](https://raw.githubusercontent.com/Friedrich-M/UniMate/main/unimate/models/denoiser/graph_adaln.py), `y = y + self.tpos_pool(tpos_emb, joints_valid)`, where `y` = timestep embedding + text embedding. That vector drives 9-way AdaLN (shift/scale/gate for spatial, temporal and MLP) in `SpatioTemporalBlock`.

```python
q = self.queries.expand(B, -1, -1)
attn_out, _ = self.cross_attn(self.norm_q(q), kv, kv, key_padding_mask=~joints_valid)
q = q + attn_out
q = q + self.ffn(self.norm_ff(q))
return self.out_proj(self.norm_out(q.mean(dim=1)))
```

**Other topology signals in the model:**
- a depth embedding and a flan-T5 joint-name embedding added to every token
- the rest-pose tokens prepended as an extra frame, so the temporal sequence is 61 long
- a root cross-attention in `FinalLayer`

**Ablations from the paper (FID):** full model 0.757; without graph bias 0.773; without Spec-RoPE 0.798; without global conditioner 0.825.

**Porting note (my inference).** The graph biases, RoPE cos/sin, pooled skeleton vector, and depth and name embeddings depend only on the skeleton. A port can split the model into two parts:
- a one-off **skeleton encoder**, run when a robot build changes
- a **denoiser step**, run on every sampling step

The eigendecomposition of a ≤70×70 matrix is trivial in JS: Jacobi iteration or ml-matrix.

## 5. Skeleton input: can we feed a robot parent array + rest offsets?

**Not through the shipped script.** [`sample.py`](https://raw.githubusercontent.com/Friedrich-M/UniMate/main/unimate/inference/sample.py) takes `{"<object_type>-<id>": "caption"}` and resolves the skeleton from the processed dataset. Unknown types are skipped. The model card says skeletons "must go through the data pipeline." In `create_sample_condition` ([conditioning.py](https://raw.githubusercontent.com/Friedrich-M/UniMate/main/unimate/dataset/conditioning.py)), even text-to-motion picks a reference clip for that object type and reads `spectral_feats`, `joint_graph_dist` and the other fields from it. My reading is that a skeleton with zero clips is skipped, so you would need at least a dummy rest-pose clip.

**The official route for your own asset:**
1. `data_process/scripts/run_export_general.sh my.glb`. This uses headless Blender. A rest pose is required; animation is optional.
2. The joint-annotation stage. LLM passes clean the bone names and choose the facing pair. It needs an OpenAI or DeepSeek key, or a local Qwen model on CUDA.
3. Stage-4 feature extraction.

Details are in the [data_process README](https://raw.githubusercontent.com/Friedrich-M/UniMate/main/data_process/README.md).

**A direct route for a robot builder (our own conditioning builder, about 100 lines).** Build these per robot:

- **`parents`:** BFS-ordered, root = −1, 5 to 70 joints, depth ≤ 19 (the depth embedding has 20 rows).
- **Rest geometry:** `offsets (J,3)` and `tpos_first_frame (J,3)` global rest positions, canonicalized the way [`skeleton.py`](https://raw.githubusercontent.com/Friedrich-M/UniMate/main/data_process/utils/skeleton.py) does:
  - facing: `across = r_hip − l_hip`, `forward = cross(up, across)`, rotated to +Z
  - root XZ centered at the origin
  - scaled so the **bone-length-weighted leaf-to-leaf diameter = 2.0**
  - grounded
- **Model input format:** `tpos` is padded to 12 dims (identity 6D rotation, zero velocity), normalized with `mean` and `std`, and parent features are built with `build_parent_features`.
- **Derived matrices:** `joint_relations`, `joint_graph_dist`, `joint_depths`, `spectral_feats (J,8)` and `edge_indexs`, all computed from the parent array (section 4).
- **`joint_names_emb (J,768)`:** a pooled flan-T5 embedding of each cleaned joint name. The cleaned vocabulary ([vocab.py](https://raw.githubusercontent.com/Friedrich-M/UniMate/main/data_process/joint_annotation/vocab.py)) is anatomical: Pelvis, Upper Arm, Forearm, Tail, Wing and so on. It has essentially no mechanical terms, so map robot parts onto anatomical names.
- **`mean` / `std`:** root and local rows from `dataset_stats.npy`, taken from one source dataset. A custom export is treated like the Objaverse data.
- **A facing pair** (r_hip, l_hip) or a body axis.

**Risks (my inference):**
- SignNet removes the sign ambiguity of the eigenvectors but not **eigenvalue multiplicity**. A chassis with 3–4 identical legs on one node gives degenerate eigenspaces.
- Wheels (continuous spin), prismatic pistons and grippers are out of distribution. The paper says rare topologies can come out "static, jittery, or semantically inaccurate."

## 6. Output format and conversion to simulator joint angles

The saved `.npy` is **(F, J, 12)**, denormalized (`motion * std + mean`), 60 frames at 30 fps ([visualization.py](https://raw.githubusercontent.com/Friedrich-M/UniMate/main/unimate/utils/visualization.py)). Per joint ([motion_utils.py](https://raw.githubusercontent.com/Friedrich-M/UniMate/main/unimate/utils/motion_utils.py)):

- **[0:3] RIFKE position:** root XZ subtracted, rotated into the facing frame, Y absolute.
- **[3:9] 6D rotation:** Zhou et al.; the docstring says the first two rows, Gram-Schmidt on decode.
- **[9:12] velocity** in the facing frame.

**Root slot:**
- [3:9] holds the **facing quaternion**, not a full root rotation.
- [1] is height.
- XZ comes from integrating [9] and [11].

**Two quirks you must undo:**
- **HML reordering.** Slot j stores the parent's local rotation. In `hml_rotations_to_bvh_quaternions`, `bvh[p] = hml[j]` is written in a loop, so for a branching parent the **last child's copy wins**. **Leaf joints get identity**, which means end-effector orientation (fist, gripper, foot pitch) is never generated.
- **T-pose rebase.** `compute_rots_from_tpos` stores `C_p · q_j · T_j⁻¹ · C_p⁻¹`, where C_p is the parent's cumulative rest rotation. The inverse is `q_j = C_p⁻¹ · q' · C_p · T_j`. If the builder exports rest poses with **identity local rotations** (offsets only), the decoded quaternions are already local rotations relative to rest.

**Conversion recipe for MuJoCo (my design):**
1. Decode 6D to rotation matrix to quaternion.
2. Un-reorder: `bvh[parents[j]] = hml[j]`.
3. Remove the rest-pose rebase.
4. Project onto each actuated DOF. For a hinge, take the swing-twist twist angle about the hinge axis. For a ball joint, use the quaternion. Clamp to joint limits.
5. Divide positions by `scale_factor`.
6. Slerp from 30 fps up to the 500–1000 Hz PD rate.
7. Use the root trajectory only as a reference for the skill layer. You can't command it in a physics sim.

The paper acknowledges "foot sliding, drift, hovering, or ground penetration." The paper does not mention physics, torque limits or robots. Treat clips as **reference motion** for a balance- and torque-aware tracker, not as feasible actuator commands.

`recover_unimate_anim_from_rot` and `run_animate_motion.sh` rebuild a BVH-ordered animation and skin it in Blender or NumPy. They do not export joint angles.

## 7. Apple Silicon blockers

- **No xformers, flash-attn, pytorch3d or custom CUDA kernels** in the model files I read: graph.py, common.py, rope.py, base.py, graph_adaln.py, transport.py and integrators.py. Attention is plain matmul/softmax, `F.scaled_dot_product_attention` and `nn.MultiheadAttention`.
- **Environment pins.** [requirements.txt](https://raw.githubusercontent.com/Friedrich-M/UniMate/main/requirements.txt) pins `torch==2.5.1+cu124` from the cu124 index, `bpy==4.0.0` (Python 3.10) and a legacy `Motion` setup.py that needs `setuptools<81`. On a Mac, use a Python 3.10 env (Chris has 3.13) with the stock macOS torch. For inference you can drop bpy, openai, google-genai and clip.
- **`torch-geometric`** is only used for `get_laplacian` and an unused `GCNConv`. It is replaceable with NumPy.
- **Device setting.** `config.json` has `"device": "cuda"`; change it to `mps` or `cpu`. The CUDA calls in sample.py are guarded.
- **Solver risk.** torchdiffeq dopri5 on MPS may fail because MPS has no float64. I did not verify this. Switching to `sampling_method="euler"` or running the ODE on CPU avoids it.
- **Pipeline stages.** Rendering, captioning and local-LLM annotation are documented as CUDA-only. None of them are needed if we build conditioning ourselves.

## 8. Feasibility of (i), (ii) and (iii)

**My compute estimates (not measured).**
- Tokens per forward pass = 61 × J.
- Linear-layer cost is about 4.19 M multiply-adds per token per layer.
- **One forward pass:** about 105 GFLOPs at J=20; about 375 GFLOPs at J=71 padded. As written, `FinalLayer` reshapes with the fixed `max_joints`, so it pads to 71 unless patched. Masking suggests an unpadded variant would give the same result.
- **Per clip, with CFG (×2):**
  - 25 Euler steps at J=20: about 5 TFLOPs
  - 50 steps at J=20: about 10 TFLOPs
  - 50 steps at J=71: about 37 TFLOPs
  - dopri5 at its defaults: likely several times more

**(i) In the browser with ONNX Runtime Web on WebGPU, or transformers.js.**
- **Export looks feasible:** standard ops, einops is traceable, and there are no custom kernels.
- **Changes needed:** export the denoiser and the skeleton encoder separately, run a JS Euler loop, fix shapes, use fp16 and watch the −inf masks.
- **Download:** about 150 MB in fp16.
- **Latency guesses:**

| Hardware | Assumed effective WebGPU throughput | Per clip (5–37 TFLOPs) |
|---|---|---|
| M3 Max | ~2–4 TFLOPS | ~2–15 s |
| Typical integrated laptop GPU | ~0.5–1 TFLOPS | ~5–75 s |
| WASM on CPU | — | minutes |

That is fine for a one-time "generate this robot's move library" step while loading a build. It is useless at Jev's 70–500 ms decision rate. flan-T5's encoder exists as ONNX for transformers.js ([Xenova/flan-t5-base](https://huggingface.co/Xenova/flan-t5-base)), but it isn't needed; see (iii).

**(ii) Offline on the M3 Max with PyTorch MPS or CPU.** Yes, after the patches in section 7.
- Estimate about 2–5 s per clip on MPS with Euler, and roughly 10–30 s on CPU.
- Hundreds of clips (body plans × moves × seeds) fit in an hour.
- The catch: players build arbitrary robots at runtime. Offline clips only cover canonical body plans (humanoid, quadruped, wheeled brawler with arms, tailed) and have to be retargeted to each variant by matching limb chains. That's easy because the limb chains come straight from the parent array.

**(iii) Replace the text encoder with fixed embeddings.** Yes, and trivially.
- graph_adaln reads only `caption_emb`: a (768,) masked-mean pool of flan-T5 encoder states ([t5.py](https://raw.githubusercontent.com/Friedrich-M/UniMate/main/unimate/models/text_encoder/t5.py), [precompute_text_emb.py](https://raw.githubusercontent.com/Friedrich-M/UniMate/main/unimate/tools/precompute_text_emb.py)).
- The unconditional branch zeroes that vector.
- Joint names are one pooled (768,) vector per name, with no template.
- So ship about 3 KB per move and about 1 MB for the whole name vocabulary, and only the denoiser goes to the client.
- The `full_cross_attn` variant needs per-token embeddings instead; those can also be precomputed.

## 9. Recommendation given the browser-only, Jev-as-controls plan

1. **Port now (cheap, MIT, deterministic).** In TS: `compute_edge_relations_and_distances`, `compute_joint_depths`, `compute_laplacian_eigenvectors` and the bone-length diameter. Use them to classify body plans, find striking chains and bilateral pairs, and give Jev typed state that doesn't depend on topology.
2. **Optional:** generate reference clips offline on the M3 Max for canonical body plans. Ship them as compact quaternion keyframes, retarget them by chain mapping, and track them with physics-aware PD plus balance correction.
3. **Only if the move library must be per-build:** in-browser ONNX with precomputed text vectors, run once when the build is finalized.
4. Before shipping any UniMate-generated content commercially, get an explicit license for the weights from the authors.

## Sources
- https://github.com/Friedrich-M/UniMate and https://api.github.com/repos/Friedrich-M/UniMate/git/trees/main?recursive=1
- https://raw.githubusercontent.com/Friedrich-M/UniMate/main/ — requirements.txt, LICENSE, configs/uniml3d_60frames_graph_adaln.json, data_process/README.md, unimate/models/denoiser/{graph_adaln.py, base.py, rope.py, blocks/graph.py, blocks/common.py}, unimate/utils/{topology_utils.py, motion_utils.py, rotation_conversions.py, visualization.py}, unimate/dataset/conditioning.py, unimate/dataset/mixture/augmentations.py, unimate/inference/{sample.py, generate.py}, unimate/models/flow/{transport.py, integrators.py}, unimate/models/text_encoder/t5.py, unimate/tools/precompute_text_emb.py, data_process/utils/{skeleton.py, motion_features.py}, data_process/joint_annotation/vocab.py
- https://huggingface.co/Linzhan/UniMate, https://huggingface.co/Linzhan/UniMate/raw/main/unimate_uniml3d_f60_v2/config.json
- https://huggingface.co/datasets/Linzhan/UniML3D, https://huggingface.co/datasets/Linzhan/Objaverse-XL-Rigged-Animated
- https://arxiv.org/html/2609.05415, https://linzhanmou.com/unimate/
- https://huggingface.co/google/flan-t5-base, https://huggingface.co/Xenova/flan-t5-base, https://github.com/inbar-2344/Motion

All file reads went through WebFetch, which returns summaries from a smaller model. Code quoted above was requested verbatim, but should be diffed against the repo before porting.

## Unknowns
- How many sampling steps / forward passes the paper's numbers used. The paper says fixed-step Euler with no step count; the code defaults to adaptive dopri5 (atol 1e-6, rtol 1e-3). Real latency per clip is unknown until someone times it.
- Which GPU the paper's '50 FPS' / 1.214 s figure was measured on, and what that time covers. Table 2 is a mesh-animation comparison.
- Whether torchdiffeq dopri5 runs on PyTorch MPS without hitting float64. Not tested; switching to Euler or running on CPU is the assumed workaround.
- Whether torch.onnx export and ONNX Runtime Web / WebGPU actually work for this model: fp16 with the -inf masks, nn.MultiheadAttention, SDPA. Not tested. All browser and laptop latencies here are FLOP-based estimates, not measurements.
- How good the output is on robot-like skeletons (wheels, prismatic pistons, grippers, several identical legs on one node). This is out of distribution for the anatomical vocabulary and the training data. Eigenvalue degeneracy is not handled by SignNet.
- The license status of the weights and of generated clips for commercial use. There is no license field on the HF model card, the training data includes non-redistributable Truebones motions, and Objaverse-XL per-object licenses are mixed (share of non-commercial assets unknown).
- The license of the inbar-2344/Motion dependency (Holden-derived): none is shown on the repo page.
- Whether sample.py can animate an object type that has zero motion clips. My reading of create_sample_condition says such skeletons are skipped, so a dummy clip or our own conditioning builder is needed.
- Exact 6D rotation convention (rows vs columns) and quaternion conventions in the Motion library. The docstring says first two rows; confirm with a round-trip test before porting.
- Whether the project's interactive demo runs live inference or only views GLB files.
- WebFetch returned summaries from a smaller model, not raw files. Code excerpts were requested verbatim but should be diffed against the repo before porting.