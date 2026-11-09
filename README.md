# CamX Studio 1.5

CamX Studio is a standalone Windows x64 application for high-bit-depth video conversion and RAW finishing. Completed CamX MediaStore outputs are discovered and downloaded through standard Android USB File Transfer (MTP); USB debugging, QR pairing and an Internet connection are not required.

## Workflow

1. Use the title-bar **Phone**, **Preview** and **Activity** workspaces. Phone is the single media and conversion workspace, and the violet CamX Studio identity remains at the far left.
2. Connect an unlocked Android phone with a data-capable USB cable and choose **File transfer / Android Auto**. CamX Studio uses Windows MTP to load only published media in the camera application's exact CamX locations; USB debugging is not used by the default workflow.
3. Phone media is separated into dedicated **SDR** and **RAW** tabs. Downloading a clip leaves it visible and marked **IN LIBRARY** while adding it to the source list in the same Phone workspace; there is no separate Converter or Downloads workspace.
4. Selecting a source opens it automatically in Preview. NPV10 and NPRAW files are developed into a cached, display-safe H.264/AAC playback proxy.
5. Once a valid source is selected, the violet title-bar **Render** control becomes available. Render uses a guided **Output** -> **Processing** -> **Render** sequence and displays only the current step.
6. The output is fully decoded and checked before it is published. A versioned SHA-256 receipt is written beside each video or inside each CinemaDNG sequence.

The source list also provides a right-click menu for Preview, Render and Remove. The title-bar **How to use** button opens a seven-step Quick Start or a complete guide covering phone setup, import, preview, every output family, processing, GPU ownership, rendering, verification and troubleshooting. Keyboard access remains available through `Ctrl+O`, `Ctrl+R`, `Ctrl+1` through `Ctrl+3`, `Space`, `Delete`, `Alt+Left/Right`, `Ctrl+Enter` and `F1`, without placing shortcut badges over navigation or action choices. Startup opens the main workspace directly; no splash window is created.

Supported imports include MOV, MP4, MKV, MXF, AVI, WebM, M4V, HEVC, compatible DNG/RAW files, CamX NPV10 v1/v2 and CamX NPRAW v2/v3/v4. NPV10/NPRAW packet CRCs are checked during decoding. Original per-frame presentation times are carried through the RGB48 processing boundary and restored at microsecond precision.

## Delivery matrix

The public workflow exposes only the requested CamX routes. SDR sources are restricted to SDR-to-SDR; RAW sources can remain RAW or develop to SDR, NDR10+, NIVUKX Vision, or any of the four NeoLog curves. No fallback may change the selected colour, chroma, bit depth, curve, or lossless scope.

| Mode | Delivery colours |
| --- | --- |
| SDR | Rec.709 SDR |
| CamX HDR | NDR10+ PQ (5,000 nit), NIVUKX Vision PQ (10,000 nit) |
| NeoLog | Scene-referred ACEScg/AP1 NeoLog Base, Shadow, Highlight and Cinema, plus a 33-cube Rec.709 viewing LUT |
| RAW | CinemaDNG identity mosaic sequence or SHA-256-verified bit-exact preservation |

| Chroma | Codec choices | Precision |
| --- | --- | --- |
| 4:4:4 | FFV1 RGB or uncompressed r210 RGB | 16-bit or 10-bit RGB; post-transform pixels preserved exactly |
| 4:2:2 | Uncompressed v210 | 10-bit codes preserved after explicit 4:2:2 sampling |
| 4:2:0 | FFV1, or runtime-proven NVENC lossless | 10-bit codes preserved after explicit 4:2:0 sampling |

FFV1 and the uncompressed transports are codec-lossless. RGB 4:4:4 is the full-colour preservation choice. A 4:2:2 or 4:2:0 file can preserve every resulting YUV code value, but chroma subsampling itself discards spatial colour information and therefore cannot be mathematically lossless relative to RAW/RGB.

Audio from standard video inputs is mastered as 24-bit PCM. When an NPV10 recording declares a camera AAC sidecar, every packet, CRC, footer and A/V origin is validated, then the authoritative AAC access units are copied without generation loss. The finished file is re-read packet by packet to verify hashes, codec configuration and timing. RAW camera streams without audio remain video-only.

## RAW development

The desktop RAW path performs:

- lossless NPRAW prediction/Deflate decoding and companding inversion;
- packed RAW12/RAW14 unpacking into a 16-bit working representation;
- black-level subtraction, white-level normalization and per-CFA white balance;
- optional 3 x 3 x 4-channel lens-shading calibration from `develop.meta`;
- noise-model-aware isolated defect-pixel repair;
- scene-cut and motion-gated temporal noise reduction;
- edge-directed Bayer demosaic into 16-bit RGB;
- sensor-domain NIV99 correction on copied CFA codes before white balance, lens shading and demosaic;
- the camera-authored sensor-to-XYZ D50 matrix route where calibration is available;
- CAT16 D50-to-D60 chromatic adaptation, an ACEScg floating-point working stage and bounded CAM16 appearance shaping;
- tetrahedral 33-cube output LUTs, highlight-aware tone mapping and error-diffusion quantization.

CinemaDNG deliberately bypasses denoise, demosaic, sharpening, tone mapping and AI. It stores the decoded CFA samples with Bayer identity, black/white levels, orientation, white balance and colour-matrix tags.

## Camera AI

The proprietary HDR path is an operation-ordered port of the camera implementation and is locked to `NDR-TONE-OP-v4`, `NDR-NIVUKX-PY-CAL-v4` and `NDR-NIVUKX-DELIVERY-v1`. It uses the camera constants, a 203-nit diffuse white, 5,000-nit NDR10+ mastering and 10,000-nit NIVUKX Vision mastering. Capability discovery fails closed if the packaged worker does not report this exact contract, and JavaScript/Python golden tests compare output code values. HLG and standards-based HDR10 are not exposed as delivery choices.

The bundled worker contains the camera project's exact `enhancement_denoise.tflite` network and a parity-gated ONNX export. On Windows it runs the network through ONNX Runtime DirectML so NVIDIA, AMD and Intel GPUs can accelerate inference. Startup readiness requires the expected hashes, a successful allocation/inference test and a comparison against the authoritative LiteRT output; if DirectML is unavailable, the worker reports the CPU fallback instead of claiming GPU acceleration.

AI is intentionally restrained: model inference supplies guidance for capped 16-bit tonal correction, denoise and micro-detail recovery. Confidence gating, scene-cut reset, temporal stabilization, motion rejection, edge protection and highlight protection reduce hallucinated texture, halos, flicker and clipping. It is available for every rendered Rec.709, NDR10+, NIVUKX Vision and NeoLog delivery. CinemaDNG and verified-copy modes bypass it because changing a sensor sample would violate RAW identity.

No single-frame super-resolution model is bundled. Instead, rendered-video conversions can use **Offline MFSR v2**, a native-resolution multi-frame reconstruction stage that operates on RGB48 frames. It aligns 3-8 real neighbouring frames with CPU phase correlation, then runs the blockwise local-motion search, confidence-weighted fusion and heteroscedastic 3-sigma ghost veto on cross-vendor WebGPU/WGSL compute. It resets at scene cuts and caps detail recovery. Uncertain motion, an unavailable GPU backend or insufficient memory causes an explicitly recorded reference-path fallback rather than fabricated detail.

Camera-master conversions also run the mandatory **NIV99/OmniClarity** finishing boundary: measured per-frame noise/texture instructions, GPU edge-aware luma/chroma cleanup and profile-aware detail recovery, cumulative halo/highlight guards, motion-gated Riven correction, and authority-gated SNCE residual colour. AI-guidance application and the canonical NDR10+/NIVUKX delivery transform also have WGSL compute kernels. Every kernel retains the RGB48 boundary, dimensions, frame count and timing.

**NIVUKX Continuum v1** is the sustained GPU execution layer. It keeps pipelines, bind groups, working buffers and a packed RGB48 eight-frame temporal ring allocated for the conversion instead of rebuilding them per stage and per frame. MFSR local-motion search, smoothing, fusion and finalization are encoded into one ordered GPU submission with one full-frame readback plus a four-byte statistics readback. AI guidance and NDR10+/NIVUKX delivery are likewise encoded as one resident frame graph with an explicit round-to-nearest RGB48 node between them, one submission and one final readback. Bounded ordered input/output queues overlap FFmpeg pipe I/O with processing without reordering or dropping frames. The startup self-test compares both fused graphs and GPU motion vectors with the discrete reference stages and rejects acceleration above a one-code-value RGB48 tolerance.

Offline MFSR is enabled by default for all 16 rendered delivery/transport combinations. CinemaDNG and RAW Preserve always bypass it because those outputs must retain decoded sensor samples or source bytes unchanged.

## Performance modes

- **Maximum:** adaptive 8-frame Offline MFSR, full lossless transport precision and the most frequent AI analysis.
- **Balanced:** adaptive 5-frame Offline MFSR with reduced AI analysis frequency; the codec remains lossless.
- **Fast:** adaptive 3-frame Offline MFSR; the codec, resolution, bit depth and selected chroma remain unchanged.

**Maximum GPU** is the default at every quality level. It uses every parity-validated WebGPU/WGSL and DirectML processing stage on compatible NVIDIA, AMD and Intel adapters. A 4:2:0 NVENC encode is used only when a startup test encodes deterministic P010 frames, decodes them, and proves identical SHA-256 values. AMD AMF and Intel QSV are not described as lossless because their available modes do not satisfy that proof. Every other system uses FFV1 for exact codec output while GPU image processing remains active. If a proven GPU encoder later fails, CamX Studio removes the incomplete attempt and retries once with FFV1 without changing resolution, chroma, bit depth, camera math or quality settings. The receipt records stage ownership, the round-trip proof and any fallback.

One conversion runs at a time so it receives the available processing budget. GPU work is submitted through NIVUKX Continuum over Vulkan or D3D12 as exposed by the installed WebGPU driver, and DirectML executes compatible AI inference. The current worker still exchanges RGB48 with FFmpeg at its boundaries, while CPU phase correlation, RAW unpack/develop, orchestration, FFV1/r210/v210 packing, I/O and validation remain CPU work. GPU utilization is therefore workload-, driver-, geometry- and transport-dependent; software cannot truthfully force a fixed percentage or make every codec operation execute on a GPU.

The x64 build supports a broad range of 64-bit Intel and AMD Windows 10/11 PCs, including systems with integrated, dedicated or external NVIDIA/AMD/Intel graphics. WebGPU/WGSL targets compatible Vulkan/D3D12 adapters without vendor-specific image-math forks, DirectML accelerates AI, and every accelerated path is parity-gated. Systems without a compatible GPU retain the exact CPU reference path and FFV1 output; the fallback is explicit and never changes the quality contract.

Activity rows report the current stage, processed/expected frames, measured processing FPS, elapsed time and ETA.

## Validation and integrity

- Outputs are created under collision-safe temporary names.
- Codec, exact pixel format, bit depth, dimensions, duration, frame count, lossless scope and colour signaling are checked against the selected profile.
- Container and camera-sensor presentation timestamps are compared frame by frame with a maximum permitted error of 2 microseconds.
- Expected audio is checked for 24-bit PCM conformance, sample rate, channel count, zero start and complete packet coverage.
- Every produced video and audio stream is decoded completely with strict FFmpeg error handling.
- The source file is hashed before and after rendering; a changed source aborts publication.
- Reusable NQIS quality instructions are accepted only when source identity, stage settings, frame count and CRC all match. A cache miss performs full analysis and publishes a newly validated cache.
- MFSR frame count, registration confidence, scene resets, rejected alignments, CPU/GPU frame totals and fallback reasons are recorded in the conversion receipt.
- NIV99 writes a hash-audited JSONL companion containing one quality event per processed frame plus its completion summary.
- NeoLog phone imports discover and copy the camera's viewing LUT beside the clip. Preview validates its 3D structure and SHA-256 receipt identity, then applies tetrahedral interpolation to the playback proxy.
- Only validated media is published; the video, receipt, viewing LUT, NeoLog identity manifest, private dynamic-delivery metadata and quality-evidence companions are staged and published atomically. Schema-v8 receipts include source/output SHA-256 values, codec-lossless scope, explicit chroma-preservation status, measured final-pixel MaxCLL/MaxFALL, GPU stage ownership, a no-silent-downgrade quality certificate, exact camera-math versions, processing settings, quality-cache identity, sustained-performance evidence, AI identity, RAW metrics and validation results.

## Build

```powershell
npm.cmd test
npm.cmd run verify:matrix
npm.cmd run verify
npm.cmd run dist:dir
& '.\dist\win-unpacked\CamX Studio.exe' --smoke-test
npm.cmd run dist
```

Packaged builds include FFmpeg, FFprobe, the CamX AI worker, the verified camera model, the native Windows MTP stream helper source and Android Platform-Tools for an explicitly enabled compatibility bridge.

## Physical limits

RAW/NPV10 input can yield a stronger desktop master than a phone export because the desktop path retains more source precision and can spend more compute per frame. An already compressed or clipped recording cannot recover sensor data that was never captured. "IMAX quality" is a capture-system and mastering specification, so software conversion alone cannot truthfully guarantee it.

The default phone path is MTP-only. It uses a direct Windows Shell stream when the device driver supports it, a bounded 4 MiB buffer, adaptive 8/16/32/64 MiB resume boundaries, SHA-256 calculated while receiving, source size/time mutation checks, a 120-second no-progress watchdog and atomic publication from an isolated transfer cache. It recovers the authoritative filename and extension from Windows Shell metadata when a phone driver hides extensions in display labels, while dot-prefixed MediaStore staging files remain excluded until finalized. Interrupted work remains non-playable and is reused only for the exact same phone item; a driver-compatible staged Shell copy is retained as the fallback. These are the transferable data-plane ideas from NIV-X Hyper; QR bootstrap, Wi-Fi/hotspot setup, TLS lanes and misleading loopback speed claims are deliberately not included in the USB MTP path. MTP is normally a single serialized USB session, so parallel network lanes cannot increase its physical link speed.

Only shared, fully published Android MediaStore content is visible through MTP. Private app-only NPV10 masters must be explicitly exported by CamX before Windows can see them; this Android security boundary is not bypassed. An opt-in ADB compatibility implementation remains in source for development and recovery, but production startup does not invoke it.

NIVUKX v5 files are preserved and downloadable as authoritative CamX masters, but they remain a proprietary encoded-packet container rather than a normal FFmpeg input. Use the camera's lossless packet-copy MOV export before desktop rendering until a separately verified desktop v5 demux/remux implementation is shipped; CamX Studio does not silently reinterpret or re-encode that container.
