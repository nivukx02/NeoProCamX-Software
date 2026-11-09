# CamX Studio 1.6.0 - production build report

Build and validation date: 2026-09-07 (Asia/Kolkata)

## Release result

CamX Studio 1.6.0 was built, validated, installed for the current Windows user, and launched successfully. Work in this release was limited to `D:\NeoProCamX Desktop`; the Android camera project was not modified.

## Deliverables

- Installer: `D:\NeoProCamX Desktop\dist\CamX-Studio-1.6.0-x64.exe`
- Installer size: 322,148,232 bytes
- Installer SHA-256: `0D8437CF9AA809EBFB9F2330791BBFB0E37EBE93568A771E0882B9E7DD2C819B`
- Unpacked application SHA-256: `724A53FD364174AC3B224D20CE5780BC440C947123EBCA386607499690DE1F32`
- Packaged `app.asar` SHA-256: `4D1FD6A0AEE4D3E5C2CAF9C15497A28D99F9C7C0364B2883478103EC36ABB7C4`
- Packaged conversion worker SHA-256: `292A65E210730473D9DE3850806D95265C07FF0E3FF495D9C04C17A225425E34`
- Checksum file: `D:\NeoProCamX Desktop\dist\SHA256SUMS.txt`

The worker in the package is byte-for-byte identical to `vendor\ai\camx-ai.exe`.

## Conversion scope

The public conversion workflow exposes only the requested routes:

- SDR to high-quality Rec.709 SDR
- RAW to high-quality Rec.709 SDR
- RAW to NDR10+
- RAW to NIVUKX Vision
- RAW to NeoLog Base, Shadow, Highlight, or Cinema
- RAW identity preservation as the original sensor stream
- RAW export as a CinemaDNG sequence

Each rendered delivery offers these explicit transport contracts:

- 16-bit RGB FFV1, 4:4:4
- 10-bit uncompressed RGB r210, 4:4:4
- 10-bit uncompressed YUV v210, 4:2:2
- 10-bit YUV FFV1, 4:2:0

FFV1, r210, and v210 preserve their encoded post-transform code values. A 4:2:0 or 4:2:2 result is lossless only after the selected chroma-subsampling transform; it cannot preserve chroma discarded by subsampling. The receipt states this distinction and rejects silent transport substitution.

Vendor HDR10+, HLG, and Dolby Vision are not public output modes. NDR10+, NIVUKX Vision, and NeoLog are identified as private CamX technologies and do not claim third-party certification.

## Camera-compatible color and quality pipeline

- The desktop locks the camera NDR/NIVUKX v4 constants and the `NDR-TONE-OP-v4`, `NDR-NIVUKX-PY-CAL-v4`, and `NDR-NIVUKX-DELIVERY-v1` contracts.
- NDR10+ and NIVUKX Vision use exact 203-nit diffuse-white and 5,000/10,000-nit mastering anchors.
- Final PQ RGB pixels are decoded and measured for MaxCLL and MaxFALL. Those measured values are embedded by stream-copy remux without re-encoding and are checked after output decode.
- CamX-private T0-T7 dynamic delivery metadata uses JzAzBz scene analysis, exact frame timing, cut-aware temporal state, and a SHA-256 hash chain. It is explicitly marked private and unsigned.
- NeoLog outputs retain their AP1/D60 identity instead of falsely declaring BT.709 or BT.2020 primaries. A manifest records the selected curve formula, coefficients, transport, and viewing-LUT hash.
- RAW development includes calibrated black/white handling, CFA-aware repair, edge-directed demosaic, temporal fusion, NIV99/OmniClarity, optional AI guidance, and Offline MFSR v2 with scene-cut and ghosting guardrails.
- VFR sensor timing and validated AAC companion timing are preserved. Completed outputs receive schema-v8 conversion receipts with hashes, stage ownership, fallback evidence, and full-decode validation.

## GPU execution

Maximum-GPU mode is the default for rendered conversions. On the tested AMD integrated GPU, the packaged worker validated all MFSR motion/fusion, NIV99/OmniClarity, AI-guidance, and NDR/NIVUKX delivery kernels through WebGPU/WGSL Vulkan. The DirectML model also passed its camera-LiteRT parity budget.

Packaged self-test evidence:

- Adapter: AMD Radeon(TM) Graphics
- Compute backend: Vulkan
- Maximum RGB48 kernel parity delta: 1 code value
- MFSR motion-vector parity delta: 0
- DirectML maximum error: `1.1146068572998047e-05`
- DirectML mean error: `5.326481300471642e-07`
- Device-resident Continuum graph and persistent resource reuse: passed

This machine has no validated hardware encoder capable of every selected mathematical-lossless transport, so `strictGpu` encoding is correctly unavailable here. GPU-compatible image-processing stages remain on the GPU; exact FFV1/r210/v210 packing, RAW unpacking, file I/O, validation, and unsupported stages use bounded CPU fallback. The application reports actual stage ownership and never promises a fixed GPU-utilization percentage or silently selects a lossy encoder.

## Phone and preview behavior

- USB File Transfer/MTP works without USB debugging and is preferred when available.
- The desktop lists only CamX-owned Cinema Cam conversion masters and separately labels direct-gallery Saved videos as non-convertible.
- Validated CamX companions remain beside imported media, and interrupted transfers retain isolated resumable state.
- RAW and unsupported playback sources use the generated preview path; preview creation is cancellable and runs outside the renderer UI thread.
- Imported files are published under the Windows Videos `CamX Studio\Phone Import ...` folder only after integrity checks pass.

## Verification evidence

- Unit/integration suite: 113 passed, 0 failed, 0 skipped.
- Full render matrix: 25 of 25 passed.
- End-to-end real-media verifier: `ok: true`.
- Matrix covered all four transports for SDR, NDR10+, NIVUKX Vision, and NeoLog; SDR-to-SDR; NeoLog Shadow/Highlight/Cinema; RAW preserve; and CinemaDNG.
- Verification additionally covered variable frame rate, exact sensor timestamps, AAC integrity, full output decode, color signaling, measured HDR metadata, MFSR cadence, and receipt integrity.
- Unpacked production smoke test: exit 0.
- Installed production smoke test: exit 0.
- Visible launch: responsive `CamX Studio` window with a nonzero Windows top-level window handle.

The release test command is serialized across hardware-heavy test files. This prevents independent Vulkan, DirectML, MFSR, and probe processes from exhausting shared memory on low-memory systems while preserving every test.

## Installation audit

- Registered product: CamX Studio 1.6.0
- Install directory: `%LOCALAPPDATA%\Programs\CamX Studio`
- Installed executable, `app.asar`, and conversion-worker hashes exactly match the audited unpacked build.
- Desktop shortcut: present
- Start-menu shortcut: present
- Current visible application instance: responsive

## Distribution boundary

The installer is not Authenticode-signed because no trusted code-signing certificate was supplied. Local build, installation, runtime, and conversion validation pass, but public distribution should add a trusted Windows signing certificate and repeat the package audit. No claim of IMAX, Dolby, HDR10+, or another vendor certification is made.
