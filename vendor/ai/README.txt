CamX Studio AI Runtime
=====================

The camx-ai executable provides the offline RGB48 processing stages and runs
the enhancement/denoise network shipped by the CamX Android camera project.
CamX Studio independently self-tests every GPU kernel and verifies both model
hashes, DirectML acceleration and LiteRT/ONNX numerical parity before reporting
each accelerated feature ready.

Model: enhancement_denoise.tflite
SHA-256: 64484177de04aa5d1ba3435ac3920bf366e58ec55ca2b1568f3258f51fd75c1c
GPU model: enhancement_denoise.onnx
SHA-256: d2381d0a73dec3df8c426c5bbe2dbf355b52b1fb89cc7b763ad9240cba6ee1b3
AI runtime: ONNX Runtime DirectML 1.24.4, with authoritative LiteRT parity
Compute runtime: WebGPU/WGSL through a compatible Vulkan or D3D12 adapter

Processing remains RGB48 around inference. The model supplies bounded guidance
for tonal correction, denoise and micro-detail recovery; confidence gating,
scene-cut reset, temporal stabilization, motion rejection, edge protection and
highlight protection prevent aggressive or unstable changes. DirectML runs the
model and WGSL applies its guidance. The AI path is used only for SDR, NDR10+
and NIVUKX deliveries.

Offline MFSR is model-free and is used by all rendered-video deliveries. CPU
phase correlation establishes the global alignment for an adaptive 3-8-frame
history. NIVUKX Continuum v1 then performs batched local-motion search,
motion/ghost rejection and bounded native-grid fusion in one GPU submission.
It retains a packed RGB48 temporal frame ring, pipelines, bind groups and
working buffers on the device across frames. AI guidance and NDR10+/NIVUKX delivery share a
resident frame graph with an explicit RGB48 quantization boundary, one GPU
submission and one final full-frame readback. NIV99/OmniClarity uses the same
persistent compute arena, while bounded ordered queues overlap decoder and
encoder pipe I/O. CinemaDNG and RAW Preserve bypass every transform to preserve
their identity contracts.

Acceleration is capability- and parity-gated, including the fused frame graphs
and GPU motion fields. Unsupported adapters use the exact CPU reference
implementation. A resident temporal-graph failure is fail-closed when an exact
continuation cannot be proven. GPU utilization is workload-dependent and is
never represented as a guaranteed percentage.

Capture-only autofocus, pose, face, depth and segmentation models are not
post-production restoration models and are therefore not run during conversion.
No third-party super-resolution model is bundled: single-frame upscalers can
invent detail and introduce frame-to-frame flicker.
