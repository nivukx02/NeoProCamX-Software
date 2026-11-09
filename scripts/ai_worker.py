"""CamX Studio neural video enhancement worker.

Streams little-endian RGB48 frames over stdin/stdout and uses the camera
enhancement model to derive conservative, temporally stable corrections.
Diagnostics are emitted on stderr so stdout always remains raw video data.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import queue
import struct
import sys
import threading
import time
import zlib
from collections import deque
from dataclasses import dataclass

import numpy as np
from ai_edge_litert.interpreter import Interpreter, OpResolverType

try:
    from gpu_compute import CONTINUUM_VERSION, GPU_COMPUTE_VERSION, GpuComputeUnavailable, WgpuComputeBackend
except Exception:  # The reference CPU runtime must remain independently deployable.
    GPU_COMPUTE_VERSION = "CAMX-WGSL-COMPUTE-v1"
    CONTINUUM_VERSION = "NIVUKX-CONTINUUM-v1"
    WgpuComputeBackend = None
    class GpuComputeUnavailable(RuntimeError):
        pass


EXPECTED_MODEL_SHA256 = "64484177de04aa5d1ba3435ac3920bf366e58ec55ca2b1568f3258f51fd75c1c"
EXPECTED_ONNX_MODEL_SHA256 = "d2381d0a73dec3df8c426c5bbe2dbf355b52b1fb89cc7b763ad9240cba6ee1b3"
MODEL_WIDTH = 256
MODEL_HEIGHT = 256
UINT16_MAX = 65535.0
MFSR_VERSION = "CAMX_OFFLINE_MFSR_V2"
NIV99_VERSION = "NIV99_OFFLINE_RGB48_V2"
NDR_TONE_VERSION = "NDR-TONE-OP-v4"
NDR_CALIBRATION_VERSION = "NDR-NIVUKX-PY-CAL-v4"
NDR_DELIVERY_VERSION = "NDR-NIVUKX-DELIVERY-v1"
DYNAMIC_METADATA_SCHEMA = "com.neoproc.camx.dynamic-delivery.v1"


def error_message(error: BaseException) -> str:
    message = str(error).strip()
    return f"{type(error).__name__}: {message}" if message else type(error).__name__
MFSR_MIN_FRAMES = 3
MFSR_MAX_FRAMES = 8

NDR_PARAMS = {
    "NDR10_PLUS": {
        "gamma": 0.859937, "toe_width": 0.238882, "toe_amount": 0.024780,
        "desat": 0.149718, "shadow_lift": 0.167837, "contrast": 0.100943,
        "chroma_boost": 0.038361, "sky_bonus": 0.062392, "peak_nits": 5000.0,
    },
    "NIVUKX_VISION": {
        "gamma": 0.800034, "toe_width": 0.289876, "toe_amount": 0.031033,
        "desat": 0.128953, "shadow_lift": 0.232156, "contrast": 0.174135,
        "chroma_boost": 0.091565, "sky_bonus": 0.080000, "peak_nits": 10000.0,
    },
}
DIFFUSE_WHITE_NITS = 203.0
BT2020_LUMA = np.array([0.2627, 0.6780, 0.0593], dtype=np.float64)
BT2020_TO_XYZ = np.array([
    [0.6369580, 0.1446169, 0.1688810],
    [0.2627002, 0.6779981, 0.0593017],
    [0.0000000, 0.0280727, 1.0609851],
], dtype=np.float64)
NQIS_MAGIC = b"NQISCACH"
NQIS_FORMAT_VERSION = 1
NQIS_INSTRUCTION_VERSION = 2
NQIS_RECORD = struct.Struct(">I12fB3x")


def smoothstep_array(edge0: float, edge1: float, values: np.ndarray) -> np.ndarray:
    t = np.clip((values - edge0) / (edge1 - edge0), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def pq_encode_nits(values: np.ndarray) -> np.ndarray:
    """Exact SMPTE ST.2084 OETF used by the camera HdrImagingMath."""
    m1 = 2610.0 / 16384.0
    m2 = 2523.0 / 32.0
    c1 = 3424.0 / 4096.0
    c2 = 2413.0 / 128.0
    c3 = 2392.0 / 128.0
    normalized = np.clip(values / 10000.0, 0.0, 1.0)
    power = np.power(normalized, m1)
    return np.clip(np.power((c1 + c2 * power) / (1.0 + c3 * power), m2), 0.0, 1.0)


def pq_decode_codes(codes: np.ndarray) -> np.ndarray:
    """Decode normalized ST.2084 code values to absolute cd/m2."""
    m1 = 2610.0 / 16384.0
    m2 = 2523.0 / 32.0
    c1 = 3424.0 / 4096.0
    c2 = 2413.0 / 128.0
    c3 = 2392.0 / 128.0
    encoded = np.clip(codes, 0.0, 1.0)
    power = np.power(encoded, 1.0 / m2)
    numerator = np.maximum(power - c1, 0.0)
    denominator = np.maximum(c2 - c3 * power, 1.0e-12)
    return np.power(numerator / denominator, 1.0 / m1) * 10000.0


def canonical_delivery_strip(
    encoded_linear: np.ndarray,
    mode: str,
    diffuse_reference: float,
    warm_skin_red_tame: float,
) -> np.ndarray:
    """Vectorized, operation-ordered port of the camera's NDR v4 delivery."""
    p = NDR_PARAMS[mode]
    rgb = np.maximum(encoded_linear.astype(np.float64) / diffuse_reference, 0.0)
    source_luma = np.maximum(np.sum(rgb * BT2020_LUMA, axis=2), 1.0e-8)

    below = source_luma <= 1.0
    gamma_lift = np.power(source_luma, p["gamma"])
    toe = smoothstep_array(0.0, p["toe_width"], source_luma) * p["toe_amount"] * (1.0 - source_luma)
    signal = np.where(below, gamma_lift + toe,
                      1.0 + (p["gamma"] - p["toe_amount"]) * (source_luma - 1.0))

    lift_window = smoothstep_array(0.025, 0.20, signal) * (1.0 - smoothstep_array(0.78, 1.20, signal))
    lifted = np.where((signal > 0.0) & (signal < 1.0),
                      signal + p["shadow_lift"] * np.sqrt(np.maximum(signal, 0.0)) * (1.0 - signal) * lift_window,
                      signal)
    contrast_window = smoothstep_array(0.055, 0.24, lifted) * (1.0 - smoothstep_array(0.76, 1.0, lifted))
    signed_contrast = (lifted - 0.50) * 4.0 * lifted * (1.0 - lifted)
    mapped_luma = np.where((lifted > 0.0) & (lifted < 1.0),
                           np.maximum(0.0, lifted + p["contrast"] * signed_contrast * contrast_window),
                           lifted)
    shaped = rgb * (mapped_luma / source_luma)[:, :, None]

    safe_green = np.maximum(rgb[:, :, 1], 1.0e-8)
    red_green = rgb[:, :, 0] / safe_green
    blue_green = rgb[:, :, 2] / safe_green
    relative_chroma = (np.max(shaped, axis=2) - np.min(shaped, axis=2)) / np.maximum(mapped_luma, 0.04)
    color_confidence = smoothstep_array(0.035, 0.22, relative_chroma)
    skin = (smoothstep_array(1.02, 1.16, red_green) *
            (1.0 - smoothstep_array(1.58, 2.10, red_green)) *
            (1.0 - smoothstep_array(0.98, 1.18, blue_green)))
    sky = smoothstep_array(1.03, 1.22, blue_green) * (1.0 - smoothstep_array(1.00, 1.22, red_green))
    tonal_window = smoothstep_array(0.035, 0.16, mapped_luma) * (1.0 - smoothstep_array(0.88, 1.65, mapped_luma))
    skin_protection = 1.0 + (0.45 - 1.0) * skin
    chroma_gain = 1.0 + (p["chroma_boost"] + p["sky_bonus"] * sky) * color_confidence * tonal_window * skin_protection
    shaped = mapped_luma[:, :, None] + (shaped - mapped_luma[:, :, None]) * chroma_gain[:, :, None]

    desat = np.clip(p["desat"] * smoothstep_array(0.55, 1.0, mapped_luma), 0.0, p["desat"])
    shaped = mapped_luma[:, :, None] + (shaped - mapped_luma[:, :, None]) * (1.0 - desat[:, :, None])

    if warm_skin_red_tame > 0.0:
        original_y = np.maximum(np.sum(shaped * BT2020_LUMA, axis=2), 1.0e-8)
        moderate_red = smoothstep_array(1.18, 1.55, red_green) * (1.0 - smoothstep_array(2.80, 4.00, red_green))
        blue_present = smoothstep_array(0.28, 0.55, blue_green) * (1.0 - smoothstep_array(1.08, 1.35, blue_green))
        exposure = smoothstep_array(0.04, 0.16, mapped_luma) * (1.0 - smoothstep_array(6.5, 8.0, mapped_luma))
        red_overflow = smoothstep_array(1.30, 2.10, red_green)
        weight = np.clip(warm_skin_red_tame * moderate_red * blue_present * exposure *
                         (0.45 + 0.55 * red_overflow), 0.0, warm_skin_red_tame)
        shaped[:, :, 0] += (np.minimum(shaped[:, :, 0], shaped[:, :, 1] * 1.42) - shaped[:, :, 0]) * weight
        shaped[:, :, 2] += (np.maximum(shaped[:, :, 2], shaped[:, :, 1] * 0.64) - shaped[:, :, 2]) * (weight * 0.68)
        corrected_y = np.maximum(np.sum(shaped * BT2020_LUMA, axis=2), 1.0e-8)
        shaped *= (original_y / corrected_y)[:, :, None]

    signal_luma = np.sum(shaped * BT2020_LUMA, axis=2)
    raw_nits = np.maximum(signal_luma, 0.0) * DIFFUSE_WHITE_NITS
    shoulder_range = p["peak_nits"] - DIFFUSE_WHITE_NITS
    nits = np.where(raw_nits <= DIFFUSE_WHITE_NITS, raw_nits,
                    DIFFUSE_WHITE_NITS + shoulder_range *
                    (1.0 - np.exp(-(raw_nits - DIFFUSE_WHITE_NITS) / shoulder_range)))
    nits = np.minimum(nits, p["peak_nits"])
    safe_signal_luma = np.maximum(signal_luma, 1.0e-8)
    rgb_nits = np.maximum(shaped * (nits / safe_signal_luma)[:, :, None], 0.0)

    high = np.max(rgb_nits, axis=2)
    overflow = (high > p["peak_nits"]) & (high > nits + 1.0e-8)
    chroma_scale = np.ones_like(high)
    chroma_scale[overflow] = np.clip(
        (p["peak_nits"] - nits[overflow]) / (high[overflow] - nits[overflow]), 0.0, 1.0
    )
    rgb_nits = nits[:, :, None] + (rgb_nits - nits[:, :, None]) * chroma_scale[:, :, None]
    rgb_nits = np.clip(rgb_nits, 0.0, p["peak_nits"])
    pq = pq_encode_nits(rgb_nits)
    pq[signal_luma <= 1.0e-8] = 0.0
    return np.clip(np.rint(pq * UINT16_MAX), 0, 65535).astype("<u2")


def apply_canonical_delivery(
    frame_u16: np.ndarray,
    mode: str,
    diffuse_reference: float,
    warm_skin_red_tame: float,
) -> np.ndarray:
    if mode == "NONE":
        return frame_u16
    if mode not in NDR_PARAMS:
        raise ValueError(f"Unknown canonical delivery mode {mode}")
    if not np.isfinite(diffuse_reference) or diffuse_reference <= 0.0 or diffuse_reference > 1.0:
        raise ValueError("Canonical delivery diffuse reference must be in (0,1]")
    output = np.empty_like(frame_u16)
    for start in range(0, frame_u16.shape[0], 64):
        end = min(frame_u16.shape[0], start + 64)
        output[start:end] = canonical_delivery_strip(
            frame_u16[start:end].astype(np.float64) / UINT16_MAX,
            mode,
            diffuse_reference,
            float(np.clip(warm_skin_red_tame, 0.0, 1.0)),
        )
    return output


class DeliveryMetadataAccumulator:
    """Measure final PQ code values without retaining video frames.

    MaxCLL is derived from the largest delivered RGB component.  Frame-average
    light uses BT.2020 luminance after exact PQ decoding, and MaxFALL is the
    largest such frame average.  A 4096-bin luminance histogram supplies stable
    percentile evidence while keeping memory bounded for long recordings.
    """

    HISTOGRAM_BINS = 4096

    def __init__(self, mode: str, width: int, height: int) -> None:
        self.mode = mode
        self.width = width
        self.height = height
        self.mastering_peak_nits = float(NDR_PARAMS[mode]["peak_nits"])
        code_axis = np.arange(65536, dtype=np.float64) / UINT16_MAX
        self.pq_lut = pq_decode_codes(code_axis)
        self.frames = 0
        self.scene_id = 0
        self.max_cll_nits = 0.0
        self.max_fall_nits = 0.0
        self.fall_sum_nits = 0.0
        self.previous_fall_nits: float | None = None
        self.temporal_state: dict[str, float] | None = None
        self.temporal_covariance = {"kneeNits": 1.0, "shoulderStrength": 1.0, "colorVolumeCompression": 1.0}

    def _percentile(self, histogram: np.ndarray, percentile: float) -> float:
        target = max(1, int(np.ceil(self.width * self.height * percentile)))
        index = int(np.searchsorted(np.cumsum(histogram), target, side="left"))
        index = min(self.HISTOGRAM_BINS - 1, max(0, index))
        return index * self.mastering_peak_nits / (self.HISTOGRAM_BINS - 1)

    def _jzazbz_summary(self, frame_u16: np.ndarray) -> dict:
        # Scene analysis is sampled on a deterministic grid. It is metadata
        # analysis only; the version-locked camera delivery pixels are untouched.
        stride = max(1, min(self.width, self.height) // 128)
        rgb_nits = self.pq_lut[frame_u16[::stride, ::stride]].astype(np.float64, copy=False)
        xyz = np.matmul(rgb_nits, BT2020_TO_XYZ.T)
        x = xyz[:, :, 0]
        y = xyz[:, :, 1]
        z = xyz[:, :, 2]
        xp = 1.15 * x - 0.15 * z
        yp = 0.66 * y + 0.34 * x
        lms = np.stack((
            0.41478972 * xp + 0.579999 * yp + 0.0146480 * z,
            -0.2015100 * xp + 1.120649 * yp + 0.0531008 * z,
            -0.0166008 * xp + 0.264800 * yp + 0.6684799 * z,
        ), axis=2)
        normalized = np.maximum(lms, 0.0) / 10000.0
        m1 = 2610.0 / 16384.0
        m2 = 1.7 * 2523.0 / 32.0
        c1 = 3424.0 / 4096.0
        c2 = 2413.0 / 128.0
        c3 = 2392.0 / 128.0
        powered = np.power(normalized, m1)
        nonlinear = np.power((c1 + c2 * powered) / (1.0 + c3 * powered), m2)
        lp, mp, sp = nonlinear[:, :, 0], nonlinear[:, :, 1], nonlinear[:, :, 2]
        iz = 0.5 * (lp + mp)
        jz = np.maximum(((1.0 - 0.56) * iz) / np.maximum(1.0 - 0.56 * iz, 1.0e-12)
                        - 1.6295499532821566e-11, 0.0)
        az = 3.524000 * lp - 4.066708 * mp + 0.542708 * sp
        bz = 0.199076 * lp + 1.096799 * mp - 1.295875 * sp
        chroma = np.hypot(az, bz)
        return {
            "appearanceSpace": "JZAZBZ_FP64_ANALYSIS",
            "sampleStride": stride,
            "sampleCount": int(jz.size),
            "meanJz": round(float(np.mean(jz)), 8),
            "meanChroma": round(float(np.mean(chroma)), 8),
            "peakChroma": round(float(np.max(chroma)), 8),
        }

    def _stabilize(self, measurements: dict[str, float], scene_reset: bool) -> dict[str, float]:
        if self.temporal_state is None or scene_reset:
            self.temporal_state = dict(measurements)
            self.temporal_covariance = {key: 1.0 for key in measurements}
            return dict(measurements)
        process_noise = 0.015
        measurement_noise = 0.12
        for key, measurement in measurements.items():
            covariance = self.temporal_covariance[key] + process_noise
            gain = covariance / (covariance + measurement_noise)
            previous = self.temporal_state[key]
            self.temporal_state[key] = previous + gain * (measurement - previous)
            self.temporal_covariance[key] = (1.0 - gain) * covariance
        return dict(self.temporal_state)

    def measure(
        self,
        frame_u16: np.ndarray,
        scene_reset: bool,
        mfsr_event: dict | None,
        niv99_event: dict | None,
        guidance: "Guidance | None",
    ) -> dict:
        maximum_code = int(np.max(frame_u16))
        frame_max = float(self.pq_lut[maximum_code])
        luma_sum = 0.0
        highlight_pixels = 0
        near_peak_pixels = 0
        histogram = np.zeros(self.HISTOGRAM_BINS, dtype=np.int64)
        for start in range(0, frame_u16.shape[0], 32):
            decoded = self.pq_lut[frame_u16[start:start + 32]]
            luma = np.sum(decoded * BT2020_LUMA, axis=2)
            luma_sum += float(np.sum(luma, dtype=np.float64))
            highlight_pixels += int(np.count_nonzero(luma >= 1000.0))
            near_peak_pixels += int(np.count_nonzero(luma >= self.mastering_peak_nits * 0.98))
            bins = np.minimum(
                self.HISTOGRAM_BINS - 1,
                np.floor(luma * self.HISTOGRAM_BINS / self.mastering_peak_nits).astype(np.int32),
            )
            histogram += np.bincount(bins.ravel(), minlength=self.HISTOGRAM_BINS)

        pixel_count = max(1, self.width * self.height)
        frame_average = luma_sum / pixel_count
        temporal_delta = 0.0 if self.previous_fall_nits is None else abs(frame_average - self.previous_fall_nits)
        if scene_reset and self.frames > 0:
            self.scene_id += 1
        self.previous_fall_nits = frame_average
        self.frames += 1
        self.max_cll_nits = max(self.max_cll_nits, frame_max)
        self.max_fall_nits = max(self.max_fall_nits, frame_average)
        self.fall_sum_nits += frame_average

        p01 = self._percentile(histogram, 0.01)
        p10 = self._percentile(histogram, 0.10)
        p50 = self._percentile(histogram, 0.50)
        p90 = self._percentile(histogram, 0.90)
        p99 = self._percentile(histogram, 0.99)
        p999 = self._percentile(histogram, 0.999)
        p9999 = self._percentile(histogram, 0.9999)
        knee = min(self.mastering_peak_nits, max(p50 + 1.0, 0.65 * p90 + 0.35 * p99))
        shoulder_strength = float(np.clip(
            1.15 + max(0.0, p99 - p90) / self.mastering_peak_nits * 4.0, 1.05, 4.12
        ))
        toe_strength = float(np.clip(0.75 + p10 / self.mastering_peak_nits * 2.2, 0.7, 1.6))
        color_volume_compression = 0.64 if self.mode == "NIVUKX_VISION" else 0.54
        omega = float(np.clip(0.5 + 0.4 * p99 / self.mastering_peak_nits, 0.5, 1.2))
        gamma_compress = float(np.clip(
            0.25 + 0.6 * max(0.0, p99 - p50) / self.mastering_peak_nits, 0.25, 0.85
        ))
        smoothed = self._stabilize({
            "kneeNits": knee,
            "shoulderStrength": shoulder_strength,
            "colorVolumeCompression": color_volume_compression,
        }, scene_reset)
        jzazbz = self._jzazbz_summary(frame_u16)

        motion = mfsr_event or {}
        quality = niv99_event or {}
        return {
            "schema": DYNAMIC_METADATA_SCHEMA,
            "privateTechnology": True,
            "tiers": {
                "T3": {
                    "sceneId": self.scene_id,
                    "boundary": bool(scene_reset),
                    "workingGamut": "BT2020_PQ_DELIVERY",
                    **jzazbz,
                    "omegaScene": round(omega, 6),
                    "gammaCompressScene": round(gamma_compress, 6),
                },
                "T4": {
                    "maxCLLNits": round(frame_max, 4),
                    "frameAverageLightNits": round(frame_average, 4),
                    "p01Nits": round(p01, 4),
                    "p10Nits": round(p10, 4),
                    "p50Nits": round(p50, 4),
                    "p90Nits": round(p90, 4),
                    "p99Nits": round(p99, 4),
                    "p999Nits": round(p999, 4),
                    "p9999Nits": round(p9999, 4),
                    "kneeNits": round(knee, 4),
                    "shoulderStrength": round(shoulder_strength, 6),
                    "toeStrength": round(toe_strength, 6),
                    "colorVolumeCompression": color_volume_compression,
                    "pixelsAbove1000Nits": round(highlight_pixels / pixel_count, 8),
                    "pixelsNearMasteringPeak": round(near_peak_pixels / pixel_count, 8),
                },
                "T5": {
                    "tileGrid": "16x16",
                    "localDeltaFields": "KNEE_CHROMA_EXPOSURE",
                    "noise": quality.get("noise"),
                    "textureConfidence": quality.get("textureConfidence"),
                    "severity": quality.get("severity"),
                    "detailProfile": quality.get("detailProfile"),
                },
                "T6": {
                    "saliencyClassesApplied": [],
                    "highlightProtection": True,
                    "haloGuard": True,
                    "rivenApplied": bool(quality.get("rivenApplied")),
                    "aiConfidence": round(float(guidance.confidence), 6) if guidance is not None else None,
                    "aiHighlightFraction": round(float(guidance.highlights), 6) if guidance is not None else None,
                },
                "T7": {
                    "filter": "SCALAR_KALMAN_CUT_AWARE_V1",
                    "sceneReset": bool(scene_reset),
                    "frameAverageDeltaNits": round(temporal_delta, 4),
                    "smoothedKneeNits": round(smoothed["kneeNits"], 4),
                    "smoothedShoulderStrength": round(smoothed["shoulderStrength"], 6),
                    "smoothedColorVolumeCompression": round(smoothed["colorVolumeCompression"], 6),
                    "mfsrFused": bool(motion.get("fused")),
                    "mfsrConfidence": motion.get("confidence"),
                    "mfsrConsensus": motion.get("consensus"),
                },
            },
        }

    def summary(self) -> dict:
        max_cll = min(self.mastering_peak_nits, self.max_cll_nits)
        max_fall = min(max_cll, self.max_fall_nits)
        return {
            "schema": DYNAMIC_METADATA_SCHEMA,
            "measurement": "exact-final-pq-rgb48-code-values",
            "framesMeasured": self.frames,
            "masteringPeakNits": int(self.mastering_peak_nits),
            "measuredMaxCLLNits": round(max_cll, 4),
            "measuredMaxFALLNits": round(max_fall, 4),
            "averageFALLNits": round(self.fall_sum_nits / max(1, self.frames), 4),
            "signalledMaxCLL": int(np.ceil(max_cll)),
            "signalledMaxFALL": int(np.ceil(max_fall)),
            "sceneCount": self.scene_id + (1 if self.frames else 0),
        }


class QualityInstructionCache:
    """CRC-protected, fixed-record NQIS reader/writer with bounded memory."""

    def __init__(self, read_path: str, write_path: str, fingerprint_json: str, expected_frames: int) -> None:
        self.fingerprint_json = fingerprint_json
        self.expected_frames = max(0, expected_frames)
        self.records: memoryview | None = None
        self.read_index = 0
        self.output = None
        self.crc = 0
        self.written = 0
        if read_path:
            self._open_read(read_path)
        elif write_path and self.expected_frames > 0:
            self._open_write(write_path)

    @property
    def hit(self) -> bool:
        return self.records is not None

    def _header_bytes(self) -> bytes:
        fingerprint = json.loads(self.fingerprint_json)
        serialized = json.dumps(fingerprint, separators=(",", ":"), ensure_ascii=False)
        identity = hashlib.sha256(serialized.encode("utf-8")).hexdigest()
        header = json.dumps({
            "instructionVersion": NQIS_INSTRUCTION_VERSION,
            "fingerprint": fingerprint,
            "fingerprintId": identity,
        }, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        return (NQIS_MAGIC + struct.pack(">III", NQIS_FORMAT_VERSION, len(header), self.expected_frames) + header)

    def _open_read(self, file_path: str) -> None:
        try:
            payload = open(file_path, "rb").read()
            if len(payload) < 28 or payload[:8] != NQIS_MAGIC:
                return
            version, header_length, count = struct.unpack_from(">III", payload, 8)
            body_length = 20 + header_length + count * NQIS_RECORD.size
            if version != NQIS_FORMAT_VERSION or count != self.expected_frames or body_length + 8 != len(payload):
                return
            stored_crc = struct.unpack_from(">Q", payload, body_length)[0] & 0xFFFFFFFF
            if zlib.crc32(payload[:body_length]) & 0xFFFFFFFF != stored_crc:
                return
            header = json.loads(payload[20:20 + header_length].decode("utf-8"))
            expected_header = json.loads(self._header_bytes()[20:].decode("utf-8"))
            if header != expected_header:
                return
            self.records = memoryview(payload)[20 + header_length:body_length]
        except Exception:
            self.records = None

    def _open_write(self, file_path: str) -> None:
        self.output = open(file_path, "xb")
        header = self._header_bytes()
        self.output.write(header)
        self.crc = zlib.crc32(header)

    def next(self, frame_index: int) -> dict | None:
        if self.records is None or frame_index != self.read_index or frame_index >= self.expected_frames:
            return None
        offset = frame_index * NQIS_RECORD.size
        unpacked = NQIS_RECORD.unpack_from(self.records, offset)
        if unpacked[0] != frame_index:
            self.records = None
            return None
        self.read_index += 1
        names = (
            "lumaNoise", "chromaNoise", "temporalInstability", "frameVariance",
            "meanLuma", "shadow", "highlight", "edgeDensity", "texture",
            "severity", "sharpen", "denoise",
        )
        result = {name: float(value) for name, value in zip(names, unpacked[1:13])}
        result["noise"] = result["lumaNoise"]
        # NIV99's live analyser exposes both the evidence name and the short internal
        # temporal key. Rehydrate the same shape on a cache hit so repeat renders
        # follow the identical processing path instead of failing after frame one.
        result["temporal"] = result["temporalInstability"]
        result["sceneCut"] = bool(unpacked[13] & 1)
        return result

    def append(self, frame_index: int, event: dict) -> None:
        if self.output is None:
            return
        if frame_index != self.written or self.written >= self.expected_frames:
            self.abort()
            return
        values = [
            event.get("lumaNoise", 0.0), event.get("chromaNoise", 0.0),
            event.get("temporalInstability", 0.0), event.get("frameVariance", 0.0),
            event.get("meanLuma", 0.0), event.get("shadowFraction", 0.0),
            event.get("highlightFraction", 0.0), event.get("edgeDensity", 0.0),
            event.get("textureConfidence", 0.0), event.get("severity", 0.0),
            event.get("sharpen", 0.0), event.get("denoise", 0.0),
        ]
        record = NQIS_RECORD.pack(frame_index, *[float(np.clip(v, 0.0, 1.0)) for v in values],
                                  1 if event.get("sceneReset") else 0)
        self.output.write(record)
        self.crc = zlib.crc32(record, self.crc)
        self.written += 1

    def commit(self, converted_frames: int) -> bool:
        if self.output is None:
            return self.hit and self.read_index == self.expected_frames == converted_frames
        if converted_frames != self.expected_frames or self.written != self.expected_frames:
            self.abort()
            return False
        self.output.write(struct.pack(">Q", self.crc & 0xFFFFFFFF))
        self.output.flush()
        os.fsync(self.output.fileno())
        self.output.close()
        self.output = None
        return True

    def abort(self) -> None:
        if self.output is not None:
            path = self.output.name
            self.output.close()
            self.output = None
            try:
                os.remove(path)
            except OSError:
                pass


def emit(event: dict) -> None:
    sys.stderr.write("#CAMX_AI#" + json.dumps(event, separators=(",", ":")) + "\n")
    sys.stderr.flush()


def file_sha256(file_path: str) -> str:
    digest = hashlib.sha256()
    with open(file_path, "rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_exact(stream, size: int) -> bytearray:
    """Read directly into one writable frame allocation.

    The writable backing store is also used as a later GPU-stage destination,
    avoiding a separate 72 MiB RGB48 output allocation for a 4096x3072 frame.
    """
    output = bytearray(size)
    view = memoryview(output)
    offset = 0
    try:
        while offset < size:
            if hasattr(stream, "readinto"):
                received = stream.readinto(view[offset:])
            else:
                chunk = stream.read(size - offset)
                received = len(chunk)
                if received:
                    view[offset:offset + received] = chunk
            if not received:
                break
            offset += received
    finally:
        view.release()
    if offset == size:
        return output
    return output[:offset]


class BoundedFrameIo:
    """Overlap decoder reads and encoder writes without reordering frames."""

    _END = object()

    def __init__(self, source, destination, frame_bytes: int, memory_mib: int) -> None:
        self.source = source
        self.destination = destination
        self.frame_bytes = frame_bytes
        budget = max(32, int(memory_mib)) * 1024 * 1024
        # Input and output queues share the budget. Four frames are enough to
        # absorb normal decoder/encoder jitter without excessive 4K/8K memory.
        self.depth = max(1, min(4, budget // max(1, frame_bytes * 2)))
        self.input_queue: queue.Queue = queue.Queue(maxsize=self.depth)
        self.output_queue: queue.Queue = queue.Queue(maxsize=self.depth)
        self.stop_event = threading.Event()
        self.reader_error: BaseException | None = None
        self.writer_error: BaseException | None = None
        self.written_frames = 0
        self.finished = False
        self.reader = threading.Thread(target=self._read_loop, name="camx-frame-reader", daemon=True)
        self.writer = threading.Thread(target=self._write_loop, name="camx-frame-writer", daemon=True)
        self.reader.start()
        self.writer.start()

    def _queue(self, target: queue.Queue, value) -> bool:
        while not self.stop_event.is_set():
            try:
                target.put(value, timeout=0.1)
                return True
            except queue.Full:
                continue
        return False

    def _read_loop(self) -> None:
        try:
            while not self.stop_event.is_set():
                raw = read_exact(self.source, self.frame_bytes)
                if not raw:
                    self._queue(self.input_queue, self._END)
                    return
                if len(raw) != self.frame_bytes:
                    raise RuntimeError(
                        f"Incomplete RGB48 frame: expected {self.frame_bytes}, received {len(raw)}"
                    )
                if not self._queue(self.input_queue, raw):
                    return
        except BaseException as error:
            self.reader_error = error
            self._queue(self.input_queue, self._END)

    def _write_loop(self) -> None:
        try:
            while not self.stop_event.is_set():
                try:
                    payload = self.output_queue.get(timeout=0.1)
                except queue.Empty:
                    continue
                if payload is self._END:
                    self.destination.flush()
                    return
                view = memoryview(payload)
                if view.format != "B" or view.ndim != 1:
                    view = view.cast("B")
                offset = 0
                while offset < view.nbytes:
                    written = self.destination.write(view[offset:])
                    if not written:
                        raise BrokenPipeError("Encoder pipe closed before the frame was written")
                    offset += written
                self.written_frames += 1
                if self.written_frames % 8 == 0:
                    self.destination.flush()
        except BaseException as error:
            self.writer_error = error
            self.stop_event.set()

    def frames(self):
        while True:
            if self.writer_error is not None:
                raise self.writer_error
            try:
                item = self.input_queue.get(timeout=0.1)
            except queue.Empty:
                if self.reader_error is not None:
                    raise self.reader_error
                if self.stop_event.is_set():
                    raise RuntimeError("Frame I/O pipeline stopped before end of stream")
                continue
            if item is self._END:
                if self.reader_error is not None:
                    raise self.reader_error
                return
            yield item

    def write(self, payload: bytes) -> None:
        while True:
            if self.writer_error is not None:
                raise self.writer_error
            if self.stop_event.is_set():
                raise RuntimeError("Frame I/O pipeline stopped before the frame was written")
            try:
                self.output_queue.put(payload, timeout=0.1)
                return
            except queue.Full:
                continue

    def write_frame(self, frame: np.ndarray) -> None:
        """Queue a contiguous frame through the buffer protocol without tobytes()."""
        if not frame.flags.c_contiguous:
            frame = np.ascontiguousarray(frame)
        self.write(memoryview(frame).cast("B"))

    def finish(self) -> None:
        if not self._queue(self.output_queue, self._END):
            if self.writer_error is not None:
                raise self.writer_error
            raise RuntimeError("Frame I/O pipeline stopped before encoder finalization")
        self.writer.join()
        self.reader.join()
        if self.reader_error is not None:
            raise self.reader_error
        if self.writer_error is not None:
            raise self.writer_error
        self.finished = True

    def abort(self) -> None:
        if self.finished:
            return
        self.stop_event.set()
        # Release queued frame memory and wake either side when a conversion
        # fails between decoder read and encoder write. The threads remain
        # daemon fallbacks for an OS pipe call that cannot be interrupted.
        for target in (self.input_queue, self.output_queue):
            while True:
                try:
                    target.get_nowait()
                except queue.Empty:
                    break
            try:
                target.put_nowait(self._END)
            except queue.Full:
                pass
        self.reader.join(timeout=0.5)
        self.writer.join(timeout=0.5)


class StreamResourceGuard:
    """Close GPU and pipe resources on every success or failure path."""

    def __init__(self) -> None:
        self.gpu_backend = None
        self.frame_io: BoundedFrameIo | None = None
        self.quality_cache: QualityInstructionCache | None = None
        self.succeeded = False

    def close(self) -> None:
        if not self.succeeded:
            if self.frame_io is not None:
                self.frame_io.abort()
            if self.quality_cache is not None:
                self.quality_cache.abort()
        if self.gpu_backend is not None:
            self.gpu_backend.close()


def resize_nearest(frame: np.ndarray, width: int, height: int) -> np.ndarray:
    source_height, source_width = frame.shape[:2]
    ys = np.minimum((np.arange(height) * source_height / height).astype(np.intp), source_height - 1)
    xs = np.minimum((np.arange(width) * source_width / width).astype(np.intp), source_width - 1)
    return frame[ys[:, None], xs[None, :], :]


def smooth_curve(values: np.ndarray, radius: int = 3) -> np.ndarray:
    padded = np.pad(values, (radius, radius), mode="edge")
    kernel = np.ones(radius * 2 + 1, dtype=np.float32) / float(radius * 2 + 1)
    return np.convolve(padded, kernel, mode="valid").astype(np.float32)


def mfsr_proxy(frame_u16: np.ndarray, maximum_edge: int = 192) -> np.ndarray:
    """Return a bounded, aspect-correct luminance proxy for registration."""
    height, width = frame_u16.shape[:2]
    scale = min(1.0, maximum_edge / float(max(width, height)))
    proxy_width = max(24, int(round(width * scale)))
    proxy_height = max(24, int(round(height * scale)))
    proxy = resize_nearest(frame_u16, proxy_width, proxy_height).astype(np.float32) / UINT16_MAX
    return proxy[:, :, 0] * 0.2126 + proxy[:, :, 1] * 0.7152 + proxy[:, :, 2] * 0.0722


def parabolic_peak(left: float, center: float, right: float) -> float:
    denominator = left - 2.0 * center + right
    if abs(denominator) < 1.0e-12:
        return 0.0
    return float(np.clip(0.5 * (left - right) / denominator, -0.5, 0.5))


def estimate_translation(
    reference: np.ndarray,
    candidate: np.ndarray,
    maximum_shift: float,
) -> tuple[float, float, float]:
    """Estimate the sub-pixel translation that must be applied to candidate."""
    if reference.shape != candidate.shape:
        return 0.0, 0.0, 0.0
    height, width = reference.shape
    window = np.hanning(height).astype(np.float32)[:, None] * np.hanning(width).astype(np.float32)[None, :]
    left = (reference - float(reference.mean())) * window
    right = (candidate - float(candidate.mean())) * window
    spectrum = np.fft.rfft2(left) * np.conj(np.fft.rfft2(right))
    spectrum /= np.maximum(np.abs(spectrum), 1.0e-9)
    correlation = np.fft.irfft2(spectrum, s=reference.shape).real
    peak_y, peak_x = np.unravel_index(int(np.argmax(correlation)), correlation.shape)
    center = float(correlation[peak_y, peak_x])
    offset_x = parabolic_peak(
        float(correlation[peak_y, (peak_x - 1) % width]),
        center,
        float(correlation[peak_y, (peak_x + 1) % width]),
    )
    offset_y = parabolic_peak(
        float(correlation[(peak_y - 1) % height, peak_x]),
        center,
        float(correlation[(peak_y + 1) % height, peak_x]),
    )
    shift_x = float(peak_x if peak_x <= width // 2 else peak_x - width) + offset_x
    shift_y = float(peak_y if peak_y <= height // 2 else peak_y - height) + offset_y
    background = float(np.mean(np.abs(correlation))) + 1.0e-9
    confidence = float(np.clip((center / background - 3.0) / 18.0, 0.0, 1.0))
    if abs(shift_x) > maximum_shift or abs(shift_y) > maximum_shift:
        return shift_x, shift_y, 0.0
    return shift_x, shift_y, confidence


def aligned_proxy_difference(
    reference: np.ndarray,
    candidate: np.ndarray,
    shift_x: float,
    shift_y: float,
) -> float:
    """Measure scene disagreement after applying the estimated candidate shift."""
    dx = int(round(shift_x))
    dy = int(round(shift_y))
    aligned = np.roll(candidate, shift=(dy, dx), axis=(0, 1))
    y0 = max(0, dy)
    y1 = min(reference.shape[0], reference.shape[0] + dy)
    x0 = max(0, dx)
    x1 = min(reference.shape[1], reference.shape[1] + dx)
    if y1 - y0 < 8 or x1 - x0 < 8:
        return 1.0
    return float(np.mean(np.abs(reference[y0:y1, x0:x1] - aligned[y0:y1, x0:x1])))


def estimate_motion_field(
    reference: np.ndarray,
    candidate: np.ndarray,
    global_shift_x: float,
    global_shift_y: float,
    columns: int = 6,
    rows: int = 4,
    search_radius: int = 2,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Refine global phase correlation into a bounded blockwise motion field."""
    height, width = reference.shape
    columns = max(1, min(columns, width // 12))
    rows = max(1, min(rows, height // 12))
    field_x = np.full((rows, columns), global_shift_x, dtype=np.float32)
    field_y = np.full((rows, columns), global_shift_y, dtype=np.float32)
    confidence = np.zeros((rows, columns), dtype=np.float32)
    base_x = int(round(global_shift_x))
    base_y = int(round(global_shift_y))
    for gy in range(rows):
        y0 = gy * height // rows
        y1 = (gy + 1) * height // rows
        for gx in range(columns):
            x0 = gx * width // columns
            x1 = (gx + 1) * width // columns
            scored: list[tuple[float, int, int]] = []
            for dy in range(base_y - search_radius, base_y + search_radius + 1):
                for dx in range(base_x - search_radius, base_x + search_radius + 1):
                    rx0 = max(x0, dx)
                    rx1 = min(x1, width + dx)
                    ry0 = max(y0, dy)
                    ry1 = min(y1, height + dy)
                    if rx1 - rx0 < 6 or ry1 - ry0 < 6:
                        continue
                    ref_block = reference[ry0:ry1, rx0:rx1]
                    candidate_block = candidate[ry0 - dy:ry1 - dy, rx0 - dx:rx1 - dx]
                    scored.append((float(np.mean(np.abs(ref_block - candidate_block))), dx, dy))
            if not scored:
                continue
            scored.sort(key=lambda item: item[0])
            best = scored[0]
            second_cost = scored[1][0] if len(scored) > 1 else best[0] + 1.0e-6
            uniqueness = float(np.clip((second_cost - best[0]) / max(second_cost, 1.0e-6), 0.0, 1.0))
            absolute = float(np.clip(1.0 - best[0] / 0.065, 0.0, 1.0))
            field_x[gy, gx] = best[1]
            field_y[gy, gx] = best[2]
            confidence[gy, gx] = uniqueness * 0.65 + absolute * 0.35

    # One conservative neighbour pass suppresses isolated block-match vectors without erasing
    # coherent subject motion or rolling-shutter gradients.
    for field in (field_x, field_y):
        padded = np.pad(field, ((1, 1), (1, 1)), mode="edge")
        neighbourhood = np.stack([
            padded[1:-1, 1:-1], padded[:-2, 1:-1], padded[2:, 1:-1],
            padded[1:-1, :-2], padded[1:-1, 2:]
        ])
        field[:, :] = np.median(neighbourhood, axis=0)
    return field_x, field_y, confidence


@dataclass
class MfsrHistoryFrame:
    # GPU-resident history does not need a second 75+ MiB host copy per 4K
    # frame.  CPU pixels are retained only for the CPU implementation.
    pixels: np.ndarray | None
    proxy: np.ndarray
    gpu_token: int | None = None


class MotionAwareMfsr:
    """Causal native-grid MFSR with sub-pixel registration and ghost rejection.

    The pass never changes dimensions and never invents a frame. It reconstructs the
    current native grid from two to seven earlier, independently registered samples.
    Any uncertain registration, scene cut, motion outlier, or memory pressure falls
    back to the unmodified current sample.
    """

    def __init__(
        self,
        width: int,
        height: int,
        requested_frames: int,
        strength: float,
        scene_threshold: float,
        memory_mib: int,
        gpu_backend=None,
    ) -> None:
        self.width = width
        self.height = height
        self.strength = float(np.clip(strength, 0.0, 1.0))
        self.scene_threshold = float(np.clip(scene_threshold, 0.025, 0.30))
        requested = int(np.clip(requested_frames, MFSR_MIN_FRAMES, MFSR_MAX_FRAMES))
        frame_bytes = max(1, width * height * 3 * 2)
        memory_frames = max(1, int(memory_mib * 1024 * 1024 // frame_bytes))
        self.active_frames = min(requested, memory_frames)
        self.enabled = self.active_frames >= MFSR_MIN_FRAMES and self.strength > 0.0
        self.history: deque[MfsrHistoryFrame] = deque(maxlen=max(1, self.active_frames - 1))
        self.frames = 0
        self.fused_frames = 0
        self.scene_resets = 0
        self.rejected_registrations = 0
        self.memory_limited = self.active_frames < requested
        self.gpu_backend = gpu_backend
        self.gpu_frames = 0
        self.gpu_fallbacks = 0
        self.gpu_motion_batches = 0
        self.gpu_motion_fields = 0
        self.gpu_motion_fallbacks = 0

    def _aligned_strip(
        self,
        pixels: np.ndarray,
        applied_shift_x: float,
        applied_shift_y: float,
        start: int,
        end: int,
        motion_field: tuple[np.ndarray, np.ndarray, np.ndarray] | None = None,
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        # np.roll(candidate, applied_shift) is the aligned image; inverse-map each
        # destination pixel into the candidate for bilinear sub-pixel sampling.
        if motion_field is None:
            shift_x = np.full((end - start, self.width), applied_shift_x, dtype=np.float32)
            shift_y = np.full((end - start, self.width), applied_shift_y, dtype=np.float32)
            local_confidence = np.ones((end - start, self.width), dtype=np.float32)
        else:
            field_x, field_y, field_confidence = motion_field
            grid_rows, grid_columns = field_x.shape
            x_grid = np.linspace(0.0, max(0, grid_columns - 1), self.width, dtype=np.float32)
            y_grid = np.linspace(0.0, max(0, grid_rows - 1), self.height, dtype=np.float32)[start:end]
            x0g = np.floor(x_grid).astype(np.intp)
            y0g = np.floor(y_grid).astype(np.intp)
            x1g = np.minimum(x0g + 1, grid_columns - 1)
            y1g = np.minimum(y0g + 1, grid_rows - 1)
            fxg = (x_grid - x0g)[None, :]
            fyg = (y_grid - y0g)[:, None]

            def interpolate(field: np.ndarray) -> np.ndarray:
                top = field[y0g[:, None], x0g[None, :]] * (1.0 - fxg) + field[y0g[:, None], x1g[None, :]] * fxg
                bottom = field[y1g[:, None], x0g[None, :]] * (1.0 - fxg) + field[y1g[:, None], x1g[None, :]] * fxg
                return top * (1.0 - fyg) + bottom * fyg

            shift_x = interpolate(field_x)
            shift_y = interpolate(field_y)
            local_confidence = interpolate(field_confidence)
        source_x = np.arange(self.width, dtype=np.float32)[None, :] - shift_x
        source_y = np.arange(start, end, dtype=np.float32)[:, None] - shift_y
        valid_x = (source_x >= 0.0) & (source_x <= self.width - 1.0)
        valid_y = (source_y >= 0.0) & (source_y <= self.height - 1.0)
        x0 = np.floor(np.clip(source_x, 0.0, self.width - 1.0)).astype(np.intp)
        y0 = np.floor(np.clip(source_y, 0.0, self.height - 1.0)).astype(np.intp)
        x1 = np.minimum(x0 + 1, self.width - 1)
        y1 = np.minimum(y0 + 1, self.height - 1)
        fx = (source_x - x0).astype(np.float32)[..., None]
        fy = (source_y - y0).astype(np.float32)[..., None]
        top = pixels[y0, x0].astype(np.float32) * (1.0 - fx) + pixels[y0, x1].astype(np.float32) * fx
        bottom = pixels[y1, x0].astype(np.float32) * (1.0 - fx) + pixels[y1, x1].astype(np.float32) * fx
        aligned = (top * (1.0 - fy) + bottom * fy) / UINT16_MAX
        valid = valid_y & valid_x
        return aligned, valid, local_confidence

    @staticmethod
    def _noise_coefficients(proxy: np.ndarray) -> tuple[float, float]:
        padded = np.pad(proxy, ((1, 1), (1, 1)), mode="edge")
        local = (
            padded[1:-1, 1:-1] * 4.0
            + padded[:-2, 1:-1]
            + padded[2:, 1:-1]
            + padded[1:-1, :-2]
            + padded[1:-1, 2:]
        ) / 8.0
        robust_sigma = float(np.median(np.abs(proxy - local)) / 0.6745)
        robust_sigma = float(np.clip(robust_sigma, 0.0012, 0.030))
        variance = robust_sigma * robust_sigma
        mean_signal = max(float(np.mean(proxy)), 0.05)
        return variance * 0.65 / mean_signal, variance * 0.35

    def process(self, frame_u16: np.ndarray) -> tuple[np.ndarray, dict]:
        self.frames += 1
        proxy = mfsr_proxy(frame_u16)
        gpu_token = None
        if self.enabled and self.gpu_backend is not None:
            try:
                gpu_token = self.gpu_backend.cache_mfsr_frame(frame_u16)
            except Exception as error:
                self.gpu_fallbacks += 1
                emit({"event": "gpu-fallback", "stage": "mfsr-residency", "message": error_message(error)})
                self.gpu_backend = None
        event = {
            "event": "mfsr",
            "version": MFSR_VERSION,
            "frame": self.frames,
            "activeFrames": 1,
            "fused": False,
            "sceneReset": False,
            "memoryLimited": self.memory_limited,
        }
        if not self.enabled:
            event["bypass"] = "memory" if self.active_frames < MFSR_MIN_FRAMES else "disabled"
            return frame_u16.copy(), event

        if self.history:
            shift_x, shift_y, confidence = estimate_translation(proxy, self.history[-1].proxy, 24.0)
            disagreement = aligned_proxy_difference(proxy, self.history[-1].proxy, shift_x, shift_y)
            if disagreement >= self.scene_threshold:
                self.history.clear()
                self.scene_resets += 1
                event.update({"sceneReset": True, "sceneDifference": round(disagreement, 6)})

        registrations: list[tuple[MfsrHistoryFrame, float, float, float, float]] = []
        scale_x = self.width / float(proxy.shape[1])
        scale_y = self.height / float(proxy.shape[0])
        for previous in reversed(self.history):
            shift_x, shift_y, confidence = estimate_translation(proxy, previous.proxy, 24.0)
            disagreement = aligned_proxy_difference(proxy, previous.proxy, shift_x, shift_y)
            if confidence < 0.08 or disagreement >= self.scene_threshold:
                self.rejected_registrations += 1
                continue
            registrations.append((previous, shift_x, shift_y, confidence, disagreement))

        candidates: list[tuple[
            MfsrHistoryFrame, float, float, float, float,
            tuple[np.ndarray, np.ndarray, np.ndarray] | None,
        ]] = [
            (previous, shift_x * scale_x, shift_y * scale_y, confidence, disagreement, None)
            for previous, shift_x, shift_y, confidence, disagreement in registrations
        ]

        # Camera contract requires an adaptive burst of at least three real frames.
        # Warm-up and poorly registered spans remain byte-identical to the current frame.
        if len(candidates) < MFSR_MIN_FRAMES - 1:
            history_pixels = None if gpu_token is not None else frame_u16.copy()
            self.history.append(MfsrHistoryFrame(history_pixels, proxy, gpu_token))
            event["bypass"] = "warmup" if len(self.history) < MFSR_MIN_FRAMES - 1 else "registration"
            return frame_u16, event

        noise_s, noise_o = self._noise_coefficients(proxy)
        output = None
        accepted_sum = 0.0
        compute_engine = "NumPy CPU"
        resident_motion = False
        if self.gpu_backend is not None:
            try:
                output, consensus_mean = self.gpu_backend.mfsr(
                    frame_u16, candidates, self.strength, noise_s, noise_o, gpu_token,
                    reference_proxy=proxy,
                    proxy_motion=[
                        (previous.proxy, shift_x, shift_y)
                        for previous, shift_x, shift_y, _confidence, _disagreement in registrations
                    ],
                    field_scale=(scale_x, scale_y),
                )
                accepted_sum = consensus_mean * self.height
                self.gpu_frames += 1
                self.gpu_motion_batches += 1
                self.gpu_motion_fields += len(candidates)
                resident_motion = True
                compute_engine = self.gpu_backend.describe()["engine"]
            except Exception as error:
                self.gpu_fallbacks += 1
                self.gpu_motion_fallbacks += 1
                emit({"event": "gpu-fallback", "stage": "mfsr", "message": error_message(error)})
                self.gpu_backend = None

        if output is None and any(item[0].pixels is None for item in candidates):
            # A GPU loss cannot reuse device-only history on the CPU.  Restart
            # the causal window from this exact frame instead of dereferencing
            # missing pixels or silently changing the current image.
            self.history.clear()
            self.history.append(MfsrHistoryFrame(frame_u16.copy(), proxy, None))
            event["bypass"] = "gpu-transition"
            event["activeFrames"] = 1
            return frame_u16, event

        if output is None:
            cpu_candidates = []
            for candidate, registration in zip(candidates, registrations):
                previous, shift_x, shift_y, confidence, disagreement = registration
                proxy_field = estimate_motion_field(proxy, previous.proxy, shift_x, shift_y)
                full_field = (
                    proxy_field[0] * scale_x,
                    proxy_field[1] * scale_y,
                    proxy_field[2],
                )
                cpu_candidates.append((
                    candidate[0], candidate[1], candidate[2], confidence, disagreement, full_field
                ))
            candidates = cpu_candidates
            output = np.empty_like(frame_u16)
            strip_height = 64
            for start in range(0, self.height, strip_height):
                end = min(self.height, start + strip_height)
                reference = frame_u16[start:end].astype(np.float32) / UINT16_MAX
                reference_luma = (
                    reference[:, :, 0] * 0.2126
                    + reference[:, :, 1] * 0.7152
                    + reference[:, :, 2] * 0.0722
                )
                accumulated = reference.copy()
                weights = np.ones(reference_luma.shape, dtype=np.float32)
                accepted = np.zeros(reference_luma.shape, dtype=np.float32)
                sigma = 3.0 * np.sqrt(np.maximum(noise_s * reference_luma + noise_o, 1.0e-8))
                for previous, shift_x, shift_y, confidence, _, motion_field in candidates:
                    aligned, valid, local_confidence = self._aligned_strip(
                        previous.pixels, shift_x, shift_y, start, end, motion_field
                    )
                    aligned_luma = (
                        aligned[:, :, 0] * 0.2126
                        + aligned[:, :, 1] * 0.7152
                        + aligned[:, :, 2] * 0.0722
                    )
                    luma_delta = np.abs(aligned_luma - reference_luma)
                    color_delta = np.max(np.abs(aligned - reference), axis=2)
                    ghost = (luma_delta > sigma + 0.0025) | (color_delta > sigma * 1.8 + 0.004)
                    similarity = np.exp(-0.5 * (luma_delta / np.maximum(sigma, 1.0e-4)) ** 2)
                    weight = self.strength * confidence * local_confidence * similarity * valid * (~ghost)
                    accumulated += aligned * weight[:, :, None]
                    weights += weight
                    accepted += (weight > 0.02).astype(np.float32)
                fused = accumulated / weights[:, :, None]

                # Bounded native-grid detail recovery. It is admitted only where at least
                # two aligned histories agree and is suppressed near black and clipping.
                upper = np.concatenate((fused[:1], fused[:-1]), axis=0)
                lower = np.concatenate((fused[1:], fused[-1:]), axis=0)
                left = np.concatenate((fused[:, :1], fused[:, :-1]), axis=1)
                right = np.concatenate((fused[:, 1:], fused[:, -1:]), axis=1)
                local = (fused * 4.0 + upper + lower + left + right) / 8.0
                consensus = np.clip(accepted / max(1.0, float(len(candidates))), 0.0, 1.0)
                exposure = np.clip((reference_luma - 0.015) / 0.08, 0.0, 1.0) * \
                    np.clip((0.985 - reference_luma) / 0.10, 0.0, 1.0)
                detail = np.clip((fused - local) * (0.14 * self.strength), -0.0025, 0.0025)
                reconstructed = fused + detail * (consensus * exposure)[:, :, None]
                output[start:end] = np.clip(np.rint(reconstructed * UINT16_MAX), 0, 65535).astype("<u2")
                accepted_sum += float(np.mean(consensus)) * (end - start)

        history_pixels = None if gpu_token is not None else frame_u16.copy()
        self.history.append(MfsrHistoryFrame(history_pixels, proxy, gpu_token))
        self.fused_frames += 1
        event.update({
            "activeFrames": 1 + len(candidates),
            "fused": True,
            "confidence": round(float(np.mean([item[3] for item in candidates])), 6),
            "meanShiftPixels": round(float(np.mean([np.hypot(item[1], item[2]) for item in candidates])), 4),
            "meanShiftX": round(float(np.mean([item[1] for item in candidates])), 4),
            "meanShiftY": round(float(np.mean([item[2] for item in candidates])), 4),
            "consensus": round(accepted_sum / self.height, 6),
            "noiseS": round(noise_s, 9),
            "noiseO": round(noise_o, 9),
            "compute": compute_engine,
            "motionCompute": compute_engine if resident_motion else "NumPy CPU",
        })
        return output, event


DETAIL_TUNING = {
    "NATURAL_DETAIL": (0.36, 0.22, 0.10),
    "FOCUSED_DETAIL": (0.52, 0.30, 0.14),
    "EXTREME_DETAIL": (0.66, 0.38, 0.18),
}


class Niv99Processor:
    """Full-frame, scene-adaptive NIV99/OmniClarity finishing in RGB48.

    The processor intentionally operates at the source raster and emits exactly one frame for every
    input frame. Its bounded spatial/chroma cleanup, multi-scale detail, highlight protection and
    motion-aware Riven correction cannot resize, synthesize, or skip a frame.
    """

    def __init__(
        self,
        width: int,
        height: int,
        detail_profile: str,
        signal_family: str,
        quality: str,
        saturation: float,
        warmth: float,
        wb_authority: str,
        riven: bool,
        gpu_backend=None,
    ) -> None:
        self.width = width
        self.height = height
        self.detail_profile = detail_profile if detail_profile in DETAIL_TUNING else "FOCUSED_DETAIL"
        self.signal_family = signal_family.upper()
        self.quality = quality.lower()
        self.saturation = float(np.clip(saturation, 0.90, 1.10))
        self.wb_authority = wb_authority.upper()
        self.warmth = float(np.clip(warmth, -0.10, 0.10)) if self.wb_authority == "AUTO" else 0.0
        self.riven = riven
        self.gpu_backend = gpu_backend
        self.gpu_frames = 0
        self.gpu_fallbacks = 0
        self.previous_proxy: np.ndarray | None = None
        self.frames = 0
        self.temporal_frames = 0
        self.riven_frames = 0
        self.scene_resets = 0
        self.noise_sum = 0.0
        self.severity_sum = 0.0

    @staticmethod
    def _measure(proxy: np.ndarray, previous: np.ndarray | None) -> dict:
        """RGB48 equivalent of the camera NQIS P010 analyzers.

        It keeps the camera's edge-rejecting second-order residual, low-motion
        temporal gate, scene-detail thresholds, and exact quality-policy inputs.
        """
        luma = proxy[:, :, 0] * 0.2126 + proxy[:, :, 1] * 0.7152 + proxy[:, :, 2] * 0.0722
        left = np.concatenate((luma[:, :1], luma[:, :-1]), axis=1)
        right = np.concatenate((luma[:, 1:], luma[:, -1:]), axis=1)
        above = np.concatenate((luma[:1], luma[:-1]), axis=0)
        below = np.concatenate((luma[1:], luma[-1:]), axis=0)
        horizontal_residual = np.abs(luma * 2.0 - left - right) * 0.5
        vertical_residual = np.abs(luma * 2.0 - above - below) * 0.5
        luma_residual = np.minimum(np.minimum(horizontal_residual, vertical_residual), 96.0 / 1023.0)
        luma_noise = float(np.clip(np.mean(luma_residual), 0.0, 1.0))

        # Local second-order opponent residual measures chroma contamination,
        # not distance from neutral (which would incorrectly classify saturation as noise).
        u = (proxy[:, :, 2] - luma) / 1.8556
        v = (proxy[:, :, 0] - luma) / 1.5748
        def channel_residual(channel: np.ndarray) -> np.ndarray:
            c_left = np.concatenate((channel[:, :1], channel[:, :-1]), axis=1)
            c_right = np.concatenate((channel[:, 1:], channel[:, -1:]), axis=1)
            c_above = np.concatenate((channel[:1], channel[:-1]), axis=0)
            c_below = np.concatenate((channel[1:], channel[-1:]), axis=0)
            return np.minimum(
                np.minimum(np.abs(channel * 2.0 - c_left - c_right) * 0.5,
                           np.abs(channel * 2.0 - c_above - c_below) * 0.5),
                128.0 / 512.0,
            )
        chroma_noise = float(np.clip((np.mean(channel_residual(u)) + np.mean(channel_residual(v))) * 0.5, 0.0, 1.0))

        temporal = 0.0
        rgb_variance = 0.0
        scene_delta = 0.0
        if previous is not None:
            previous_luma = previous[:, :, 0] * 0.2126 + previous[:, :, 1] * 0.7152 + previous[:, :, 2] * 0.0722
            previous_u = (previous[:, :, 2] - previous_luma) / 1.8556
            previous_v = (previous[:, :, 0] - previous_luma) / 1.5748
            luma_delta = np.abs(luma - previous_luma)
            chroma_delta = np.maximum(np.abs(u - previous_u), np.abs(v - previous_v))
            stable = (luma_delta <= 22.0 / 1023.0) & (chroma_delta <= 34.0 / 512.0)
            if np.any(stable):
                temporal = float(np.mean(luma_delta[stable]))
                rgb_variance = float(np.mean(np.mean(np.abs(proxy - previous), axis=2)[stable]))
            scene_delta = float(np.mean(np.abs(proxy - previous)))
        scene_cut = previous is not None and scene_delta >= 0.10

        horizontal_gradient = np.abs(luma - left)
        vertical_gradient = np.abs(luma - above)
        gradient = (horizontal_gradient + vertical_gradient) * 0.5
        shadow = float(np.mean(luma < 0.12))
        highlight = float(np.mean(luma > 0.90))
        edge_density = float(np.mean(gradient >= 0.035))
        texture_fraction = float(np.mean((gradient >= 0.006) & (gradient <= 0.055)))
        texture = float(np.clip(texture_fraction * 2.4 + edge_density * 0.35, 0.0, 1.0))
        severity = float(max(
            np.clip(luma_noise / 0.75, 0.0, 0.35),
            np.clip(chroma_noise * 0.72, 0.0, 0.72),
            np.clip(temporal * 1.15, 0.0, 1.0),
            np.clip(rgb_variance * 0.90, 0.0, 0.90),
        ))
        return {
            "noise": luma_noise,
            "lumaNoise": luma_noise,
            "chromaNoise": chroma_noise,
            "texture": texture,
            "temporal": temporal,
            "temporalInstability": temporal,
            "frameVariance": rgb_variance,
            "sceneCut": scene_cut,
            "severity": severity,
            "meanLuma": float(np.mean(luma)),
            "shadow": shadow,
            "highlight": highlight,
            "edgeDensity": edge_density,
        }

    @staticmethod
    def _cross_blur(source: np.ndarray, core_start: int, core_end: int, radius: int) -> np.ndarray:
        center = source[core_start:core_end]
        upper = source[np.maximum(np.arange(core_start, core_end) - radius, 0)]
        lower = source[np.minimum(np.arange(core_start, core_end) + radius, source.shape[0] - 1)]
        if radius == 1:
            left = np.concatenate((center[:, :1], center[:, :-1]), axis=1)
            right = np.concatenate((center[:, 1:], center[:, -1:]), axis=1)
        else:
            left = np.concatenate((center[:, :1].repeat(radius, axis=1), center[:, :-radius]), axis=1)
            right = np.concatenate((center[:, radius:], center[:, -1:].repeat(radius, axis=1)), axis=1)
        return (center * 4.0 + upper + lower + left + right) / 8.0

    def _apply_strip(self, frame: np.ndarray, start: int, end: int, metrics: dict, motion: dict | None) -> np.ndarray:
        halo = 2
        halo_start = max(0, start - halo)
        halo_end = min(self.height, end + halo)
        source = frame[halo_start:halo_end].astype(np.float32) / UINT16_MAX
        core_start = start - halo_start
        core_end = core_start + end - start
        center = source[core_start:core_end]
        local = self._cross_blur(source, core_start, core_end, 1)
        wide = self._cross_blur(source, core_start, core_end, 2)
        luma = center[:, :, 0] * 0.2126 + center[:, :, 1] * 0.7152 + center[:, :, 2] * 0.0722
        local_luma = local[:, :, 0] * 0.2126 + local[:, :, 1] * 0.7152 + local[:, :, 2] * 0.0722
        fine = center - local
        structure = center - wide
        edge = np.max(np.abs(fine), axis=2)

        clean_sharp, noisy_sharp, micro = DETAIL_TUNING[self.detail_profile]
        # Exact ConversionFrameQualityPolicy.resolve port. Quality presets change
        # scheduling/codec effort, never these camera-authored pixel controls.
        texture_lift = metrics["texture"] * (1.0 - metrics["severity"]) * 0.10
        sharp = metrics.get("sharpen", clean_sharp + (noisy_sharp - clean_sharp) * metrics["severity"] +
                            texture_lift - metrics["highlight"] * 0.025)
        sharp = float(np.clip(sharp, 0.12, 0.72))
        clean_denoise = 0.32 if self.signal_family == "SDR" else 0.28
        noisy_denoise = 0.66 if self.signal_family == "SDR" else 0.58
        denoise = metrics.get("denoise", (clean_denoise + (noisy_denoise - clean_denoise) * metrics["severity"]) *
                              (1.0 - metrics["texture"] * 0.22) + metrics["shadow"] * 0.035)
        denoise = float(np.clip(denoise, 0.22, 0.76))

        noise_floor = max(0.0012, metrics["noise"])
        edge_gate = np.clip(1.0 - edge / max(0.012, noise_floor * 5.5), 0.0, 1.0)[..., None]
        # Edge-aware luma/chroma denoise. Chroma receives more cleanup while coherent colour edges remain.
        refined = center + (local - center) * (denoise * 0.22 * edge_gate)
        refined_luma = refined[:, :, 0] * 0.2126 + refined[:, :, 1] * 0.7152 + refined[:, :, 2] * 0.0722
        chroma = refined - refined_luma[:, :, None]
        local_chroma = local - local_luma[:, :, None]
        chroma_gate = np.clip(1.0 - edge / 0.045, 0.12, 1.0)[..., None]
        refined -= chroma
        refined += chroma + (local_chroma - chroma) * (denoise * 0.12 * chroma_gate)

        texture_gate = np.clip((edge - noise_floor * 0.55) / 0.020, 0.0, 1.0)
        halo_gate = np.clip((0.080 - edge) / 0.050, 0.0, 1.0)
        exposure_gate = np.clip((luma - 0.018) / 0.080, 0.0, 1.0) * np.clip((0.985 - luma) / 0.10, 0.0, 1.0)
        detail_gate = (texture_gate * halo_gate * exposure_gate)[..., None]
        detail = fine * (sharp * 0.11) + structure * (micro * 0.045)
        detail = np.clip(detail, -0.0045, 0.0045)
        refined += detail * detail_gate

        riven_applied = False
        if self.riven and motion and motion.get("fused") and motion.get("confidence", 0.0) >= 0.20:
            shift_x = float(motion.get("meanShiftX", 0.0))
            shift_y = float(motion.get("meanShiftY", 0.0))
            magnitude = float(np.hypot(shift_x, shift_y))
            if 0.30 <= magnitude <= 8.0:
                dx = int(np.clip(round(shift_x / max(magnitude, 1.0)), -1, 1))
                dy = int(np.clip(round(shift_y / max(magnitude, 1.0)), -1, 1))
                rows = np.arange(core_start, core_end)
                before_y = np.clip(rows - dy, 0, source.shape[0] - 1)
                after_y = np.clip(rows + dy, 0, source.shape[0] - 1)
                columns = np.arange(self.width)
                before_x = np.clip(columns - dx, 0, self.width - 1)
                after_x = np.clip(columns + dx, 0, self.width - 1)
                before = source[before_y[:, None], before_x[None, :]]
                after = source[after_y[:, None], after_x[None, :]]
                motion_detail = center - (before + after) * 0.5
                snr_gate = np.clip((edge - noise_floor) / 0.030, 0.0, 1.0) * exposure_gate
                amount = min(0.075, 0.018 + magnitude * 0.006) * float(motion.get("confidence", 0.0))
                refined += np.clip(motion_detail * amount, -0.0025, 0.0025) * snr_gate[:, :, None]
                riven_applied = True

        # SNCE residual colour is intentionally bounded and white-balance authority is respected.
        final_luma = refined[:, :, 0] * 0.2126 + refined[:, :, 1] * 0.7152 + refined[:, :, 2] * 0.0722
        final_chroma = refined - final_luma[:, :, None]
        saturation = 1.0 + (self.saturation - 1.0) * (1.0 - metrics["highlight"] * 0.45)
        refined = final_luma[:, :, None] + final_chroma * saturation
        if abs(self.warmth) > 1.0e-6:
            warmth_gate = (np.clip((final_luma - 0.02) / 0.12, 0.0, 1.0) *
                           np.clip((0.96 - final_luma) / 0.16, 0.0, 1.0))[..., None]
            warmth_vector = np.array([0.55, 0.02, -0.55], dtype=np.float32)[None, None, :]
            refined += warmth_vector * self.warmth * 0.035 * warmth_gate

        # A cumulative delta budget is the final halo/noise guard for every stage combined.
        budget = 0.008 if self.detail_profile == "EXTREME_DETAIL" else 0.006
        refined = np.minimum(center + budget, np.maximum(center - budget, refined))
        return np.clip(np.rint(refined * UINT16_MAX), 0, 65535).astype("<u2"), riven_applied

    def process(
        self,
        frame_u16: np.ndarray,
        motion: dict | None = None,
        cached_metrics: dict | None = None,
        delivery: dict | None = None,
        destination: np.ndarray | None = None,
    ) -> tuple[np.ndarray, dict]:
        frame_started = time.perf_counter_ns()
        proxy = resize_nearest(frame_u16, min(256, self.width), min(256, self.height)).astype(np.float32) / UINT16_MAX
        metrics = cached_metrics if cached_metrics is not None else self._measure(proxy, self.previous_proxy)
        if metrics["sceneCut"]:
            self.scene_resets += 1
            self.previous_proxy = None
        clean_sharp, noisy_sharp, micro = DETAIL_TUNING[self.detail_profile]
        sharp = float(np.clip(
            metrics.get("sharpen", clean_sharp + (noisy_sharp - clean_sharp) * metrics["severity"] +
                        metrics["texture"] * (1.0 - metrics["severity"]) * 0.10 - metrics["highlight"] * 0.025),
            0.12, 0.72,
        ))
        clean_denoise = 0.32 if self.signal_family == "SDR" else 0.28
        noisy_denoise = 0.66 if self.signal_family == "SDR" else 0.58
        denoise = float(np.clip(
            metrics.get("denoise", (clean_denoise + (noisy_denoise - clean_denoise) * metrics["severity"]) *
                        (1.0 - metrics["texture"] * 0.22) + metrics["shadow"] * 0.035),
            0.22, 0.76,
        ))
        output = None
        any_riven = False
        compute_engine = "NumPy CPU"
        if self.gpu_backend is not None:
            try:
                output, any_riven = self.gpu_backend.niv99(
                    frame_u16,
                    sharp=sharp,
                    denoise=denoise,
                    micro=micro,
                    noise_floor=max(0.0012, metrics["noise"]),
                    saturation=1.0 + (self.saturation - 1.0) * (1.0 - metrics["highlight"] * 0.45),
                    warmth=self.warmth,
                    budget=0.008 if self.detail_profile == "EXTREME_DETAIL" else 0.006,
                    motion=motion if self.riven else None,
                    delivery_mode=delivery["mode"] if delivery else "NONE",
                    diffuse_reference=delivery["diffuseReference"] if delivery else 0.18,
                    warm_skin_red_tame=delivery["warmSkinRedTame"] if delivery else 0.50,
                    delivery_parameters=delivery["parameters"] if delivery else None,
                    destination=destination,
                )
                self.gpu_frames += 1
                compute_engine = self.gpu_backend.describe()["engine"]
            except Exception as error:
                self.gpu_fallbacks += 1
                emit({"event": "gpu-fallback", "stage": "niv99", "message": error_message(error)})
                self.gpu_backend = None
        if output is None:
            output = destination
            if (output is None or output.shape != frame_u16.shape or output.dtype != frame_u16.dtype or
                    not output.flags.c_contiguous or not output.flags.writeable or
                    np.shares_memory(output, frame_u16)):
                output = np.empty_like(frame_u16)
            for start in range(0, self.height, 64):
                end = min(self.height, start + 64)
                output[start:end], applied = self._apply_strip(frame_u16, start, end, metrics, motion)
                any_riven = any_riven or applied
        self.previous_proxy = proxy
        self.frames += 1
        self.temporal_frames += int(metrics["temporal"] > 0.0 and not metrics["sceneCut"])
        self.riven_frames += int(any_riven)
        self.noise_sum += metrics["noise"]
        self.severity_sum += metrics["severity"]
        return output, {
            "event": "niv99",
            "version": NIV99_VERSION,
            "frame": self.frames,
            "detailProfile": self.detail_profile,
            "signalFamily": self.signal_family,
            "noise": round(metrics["noise"], 7),
            "lumaNoise": round(metrics["lumaNoise"], 7),
            "chromaNoise": round(metrics["chromaNoise"], 7),
            "temporalInstability": round(metrics["temporalInstability"], 7),
            "frameVariance": round(metrics["frameVariance"], 7),
            "meanLuma": round(metrics["meanLuma"], 7),
            "shadowFraction": round(metrics["shadow"], 7),
            "highlightFraction": round(metrics["highlight"], 7),
            "edgeDensity": round(metrics["edgeDensity"], 7),
            "textureConfidence": round(metrics["texture"], 6),
            "severity": round(metrics["severity"], 6),
            "sharpen": round(sharp, 7),
            "denoise": round(denoise, 7),
            "sceneReset": metrics["sceneCut"],
            "rivenApplied": any_riven,
            "whiteBalanceAuthority": self.wb_authority,
            "residualWarmthApplied": abs(self.warmth) > 1.0e-6,
            "compute": compute_engine,
            "continuum": {
                "version": CONTINUUM_VERSION,
                "stages": ["NIV99/OmniClarity", "RGB48 exact boundary", "NDR/NIVUKX delivery"],
                "submissions": 1,
                "fullFrameReadbacks": 1,
            } if delivery and output is not None and compute_engine != "NumPy CPU" else None,
            "deliveryFused": bool(delivery and output is not None and compute_engine != "NumPy CPU"),
            "processingMs": round((time.perf_counter_ns() - frame_started) / 1_000_000.0, 4),
        }


@dataclass
class Guidance:
    curves: np.ndarray
    denoise_mix: float
    detail_mix: float
    temporal_mix: float
    model_delta: float
    confidence: float
    noise: float
    texture: float
    highlights: float


class CameraEnhancementModel:
    def __init__(self, model_path: str, threads: int, strength: float,
                 onnx_model_path: str = "", prefer_gpu: bool = True) -> None:
        actual_hash = file_sha256(model_path)
        if actual_hash.lower() != EXPECTED_MODEL_SHA256:
            raise RuntimeError(f"Camera AI model integrity check failed ({actual_hash})")
        self.model_path = model_path
        self.model_hash = actual_hash
        self.strength = float(np.clip(strength, 0.0, 1.0))
        self.engine = "LiteRT CPU"
        self.acceleration_error = None
        self.session = None
        self.session_input = "input_nhwc"
        self.session_output = "output_nhwc"
        if prefer_gpu and onnx_model_path:
            try:
                onnx_hash = file_sha256(onnx_model_path)
                if onnx_hash.lower() != EXPECTED_ONNX_MODEL_SHA256:
                    raise RuntimeError(f"DirectML model integrity check failed ({onnx_hash})")
                import onnxruntime as ort
                if "DmlExecutionProvider" not in ort.get_available_providers():
                    raise RuntimeError("DirectML execution provider is unavailable")
                options = ort.SessionOptions()
                options.enable_mem_pattern = False
                options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
                options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
                options.add_session_config_entry("session.disable_cpu_ep_fallback", "1")
                self.session = ort.InferenceSession(
                    onnx_model_path, sess_options=options, providers=["DmlExecutionProvider"]
                )
                self.engine = "ONNX Runtime DirectML"
                self.onnx_model_hash = onnx_hash
            except Exception as error:
                self.session = None
                self.acceleration_error = str(error)
        if self.session is not None:
            self.interpreter = None
            self.input = {"index": 0, "shape": np.array([1, MODEL_HEIGHT, MODEL_WIDTH, 3], dtype=np.int32)}
            self.output = {"index": 0, "shape": np.array([1, MODEL_HEIGHT, MODEL_WIDTH, 3], dtype=np.int32)}
            return
        self.interpreter = Interpreter(
            model_path=model_path,
            num_threads=max(1, threads),
            experimental_op_resolver_type=OpResolverType.BUILTIN_WITHOUT_DEFAULT_DELEGATES,
        )
        input_index = self.interpreter.get_input_details()[0]["index"]
        self.interpreter.resize_tensor_input(
            input_index,
            [1, MODEL_HEIGHT, MODEL_WIDTH, 3],
            strict=False,
        )
        self.interpreter.allocate_tensors()
        self.input = self.interpreter.get_input_details()[0]
        self.output = self.interpreter.get_output_details()[0]

    def predict(self, tensor: np.ndarray) -> np.ndarray:
        if self.session is not None:
            return np.asarray(self.session.run([self.session_output], {self.session_input: tensor})[0])
        self.interpreter.set_tensor(self.input["index"], tensor)
        self.interpreter.invoke()
        return self.interpreter.get_tensor(self.output["index"])

    def analyze(self, proxy: np.ndarray) -> Guidance:
        tensor = np.ascontiguousarray(proxy[np.newaxis, ...], dtype=np.float32)
        started = time.perf_counter()
        prediction = np.clip(self.predict(tensor)[0], 0.0, 1.0)
        elapsed_ms = round((time.perf_counter() - started) * 1000.0)
        residual = prediction - proxy
        model_delta = float(np.mean(np.abs(residual)))

        luma = proxy[:, :, 0] * 0.2126 + proxy[:, :, 1] * 0.7152 + proxy[:, :, 2] * 0.0722
        padded_luma = np.pad(luma, ((1, 1), (1, 1)), mode="edge")
        local_luma = (
            padded_luma[1:-1, 1:-1] * 4.0
            + padded_luma[:-2, 1:-1]
            + padded_luma[2:, 1:-1]
            + padded_luma[1:-1, :-2]
            + padded_luma[1:-1, 2:]
        ) / 8.0
        residual_luma = np.abs(luma - local_luma)
        noise = float(np.median(residual_luma) / 0.6745)
        texture = float(np.percentile(residual_luma, 75))
        highlights = float(np.mean(luma >= 0.90))
        # Large model residuals are more likely to represent an out-of-domain scene.
        # Fade the learned correction instead of trusting it unconditionally.
        confidence = float(np.clip(1.0 - max(0.0, model_delta - 0.055) / 0.12, 0.20, 1.0))

        curves = np.zeros((3, 256), dtype=np.float32)
        bins = np.minimum((proxy * 255.0).astype(np.intp), 255)
        for channel in range(3):
            channel_bins = bins[:, :, channel].reshape(-1)
            channel_delta = residual[:, :, channel].reshape(-1)
            counts = np.bincount(channel_bins, minlength=256).astype(np.float32)
            totals = np.bincount(channel_bins, weights=channel_delta, minlength=256).astype(np.float32)
            populated = counts > 8
            curve = np.zeros(256, dtype=np.float32)
            curve[populated] = totals[populated] / counts[populated]
            if np.any(populated):
                known = np.flatnonzero(populated)
                curve = np.interp(np.arange(256), known, curve[known]).astype(np.float32)
            curves[channel] = np.clip(smooth_curve(curve), -0.018, 0.018)

        # The trained model may make strong changes on synthetic/noisy inputs. The desktop
        # pipeline deliberately caps both tonal and spatial influence to protect real texture.
        curves *= self.strength * 0.28 * confidence
        denoise_mix = float(np.clip(noise * 3.2 + model_delta * 0.07, 0.004, 0.045) * self.strength * confidence)
        detail_mix = float(np.clip((0.022 - noise) * 2.8, 0.0, 0.055) * self.strength * confidence)
        temporal_mix = float(np.clip(self.strength * confidence, 0.0, 1.0))
        emit({
            "event": "inference",
            "ms": elapsed_ms,
            "delta": round(model_delta, 6),
            "mix": round(denoise_mix, 6),
            "detail": round(detail_mix, 6),
            "confidence": round(confidence, 6),
            "noise": round(noise, 6),
            "texture": round(texture, 6),
            "highlights": round(highlights, 6),
            "engine": self.engine,
        })
        return Guidance(
            curves=curves,
            denoise_mix=denoise_mix,
            detail_mix=detail_mix,
            temporal_mix=temporal_mix,
            model_delta=model_delta,
            confidence=confidence,
            noise=noise,
            texture=texture,
            highlights=highlights,
        )


def blend_guidance(previous: Guidance, current: Guidance, amount: float = 0.32) -> Guidance:
    a = float(np.clip(amount, 0.0, 1.0))
    mix = lambda old, new: old * (1.0 - a) + new * a
    return Guidance(
        curves=previous.curves * (1.0 - a) + current.curves * a,
        denoise_mix=mix(previous.denoise_mix, current.denoise_mix),
        detail_mix=mix(previous.detail_mix, current.detail_mix),
        temporal_mix=mix(previous.temporal_mix, current.temporal_mix),
        model_delta=current.model_delta,
        confidence=current.confidence,
        noise=current.noise,
        texture=current.texture,
        highlights=current.highlights,
    )


def apply_guidance(
    frame_u16: np.ndarray,
    guidance: Guidance,
    previous_u16: np.ndarray | None,
    temporal_strength: float,
) -> np.ndarray:
    height, width = frame_u16.shape[:2]
    output = np.empty_like(frame_u16)
    strip_height = 96

    for start in range(0, height, strip_height):
        end = min(height, start + strip_height)
        halo_start = max(0, start - 1)
        halo_end = min(height, end + 1)
        source = frame_u16[halo_start:halo_end].astype(np.float32) / UINT16_MAX
        core_start = start - halo_start
        core_end = core_start + (end - start)
        center = source[core_start:core_end]
        upper = source[np.maximum(np.arange(core_start, core_end) - 1, 0)]
        lower = source[np.minimum(np.arange(core_start, core_end) + 1, source.shape[0] - 1)]
        left = np.concatenate((center[:, :1], center[:, :-1]), axis=1)
        right = np.concatenate((center[:, 1:], center[:, -1:]), axis=1)
        local = (center * 4.0 + upper + lower + left + right) / 8.0
        detail = np.max(np.abs(center - local), axis=2)
        edge_gate = np.clip(1.0 - detail / 0.035, 0.0, 1.0)[..., None]
        refined = center + (local - center) * (guidance.denoise_mix * edge_gate)

        # Recover only bounded micro-contrast. Strong edges, deep shadows and
        # highlights are protected so the pass cannot create ringing or clipping.
        texture_gate = np.clip((detail - 0.0015) / 0.012, 0.0, 1.0) * np.clip((0.055 - detail) / 0.025, 0.0, 1.0)
        luminance = center[:, :, 0] * 0.2126 + center[:, :, 1] * 0.7152 + center[:, :, 2] * 0.0722
        exposure_gate = np.clip((luminance - 0.025) / 0.075, 0.0, 1.0) * np.clip((0.94 - luminance) / 0.12, 0.0, 1.0)
        detail_boost = (center - local) * (guidance.detail_mix * texture_gate * exposure_gate)[..., None]
        detail_boost = np.clip(detail_boost, -0.0035, 0.0035)
        refined += detail_boost

        if previous_u16 is not None and temporal_strength > 0.0:
            previous = previous_u16[start:end].astype(np.float32) / UINT16_MAX
            motion = np.max(np.abs(center - previous), axis=2)
            motion_gate = np.clip(1.0 - motion / 0.024, 0.0, 1.0) ** 2
            temporal_mix = min(0.18, temporal_strength * guidance.temporal_mix)
            refined = refined * (1.0 - temporal_mix * motion_gate[..., None]) + previous * (temporal_mix * motion_gate[..., None])

        indices = np.minimum(frame_u16[start:end] >> 8, 255).astype(np.uint8)
        for channel in range(3):
            tonal_gate = np.clip((0.985 - center[:, :, channel]) / 0.08, 0.0, 1.0)
            refined[:, :, channel] += guidance.curves[channel][indices[:, :, channel]] * tonal_gate
        output[start:end] = np.clip(np.rint(refined * UINT16_MAX), 0, 65535).astype("<u2")
    return output


def create_gpu_backend(mode: str):
    if mode == "cpu":
        return None
    if WgpuComputeBackend is None:
        if mode == "gpu":
            raise GpuComputeUnavailable("The packaged WebGPU compute runtime is unavailable")
        return None
    try:
        return WgpuComputeBackend()
    except Exception:
        if mode == "gpu":
            raise
        return None


def inspect_gpu_compute() -> dict:
    """Compile and numerically validate every GPU kernel against its CPU reference."""
    started = time.perf_counter()
    try:
        backend = create_gpu_backend("gpu")
        rng = np.random.default_rng(0xCA9)
        frame = rng.integers(1024, 64000, size=(32, 48, 3), dtype=np.uint16)

        delivery_delta = 0
        for mode in NDR_PARAMS:
            expected = apply_canonical_delivery(frame, mode, 0.18, 0.50)
            actual = backend.canonical_delivery(frame, mode, 0.18, 0.50, NDR_PARAMS)
            delivery_delta = max(delivery_delta, int(np.max(np.abs(
                expected.astype(np.int32) - actual.astype(np.int32)
            ))))

        cpu_niv99 = Niv99Processor(48, 32, "EXTREME_DETAIL", "SDR", "maximum",
                                   1.0, 0.0, "MANUAL", True)
        gpu_niv99 = Niv99Processor(48, 32, "EXTREME_DETAIL", "SDR", "maximum",
                                   1.0, 0.0, "MANUAL", True, backend)
        expected_niv99, _ = cpu_niv99.process(frame)
        actual_niv99, _ = gpu_niv99.process(frame)
        niv99_delta = int(np.max(np.abs(expected_niv99.astype(np.int32) - actual_niv99.astype(np.int32))))
        discrete_niv99_delivery = backend.canonical_delivery(
            actual_niv99, "NDR10_PLUS", 0.18, 0.50, NDR_PARAMS
        )
        fused_niv99 = Niv99Processor(48, 32, "EXTREME_DETAIL", "SDR", "maximum",
                                     1.0, 0.0, "MANUAL", True, backend)
        fused_niv99_delivery, fused_niv99_event = fused_niv99.process(frame, delivery={
            "mode": "NDR10_PLUS", "diffuseReference": 0.18, "warmSkinRedTame": 0.50,
            "parameters": NDR_PARAMS,
        })
        niv99_delivery_delta = int(np.max(np.abs(
            discrete_niv99_delivery.astype(np.int32) - fused_niv99_delivery.astype(np.int32)
        )))

        curves = rng.uniform(-0.003, 0.003, size=(3, 256)).astype(np.float32)
        guidance = Guidance(curves, 0.02, 0.03, 0.70, 0.01, 0.90, 0.01, 0.02, 0.01)
        previous = rng.integers(1024, 64000, size=frame.shape, dtype=np.uint16)
        expected_guidance = apply_guidance(frame, guidance, previous, 0.12)
        actual_guidance = backend.apply_ai_guidance(
            frame, curves, guidance.denoise_mix, guidance.detail_mix,
            0.12 * guidance.temporal_mix, previous,
        )
        guidance_delta = int(np.max(np.abs(
            expected_guidance.astype(np.int32) - actual_guidance.astype(np.int32)
        )))

        # The production graph must preserve the same RGB48 boundary as separate
        # submissions while retaining the prior AI result in device memory.
        resident_source_a = frame
        resident_source_b = np.roll(frame, 1, axis=1)
        discrete_ai_a = backend.apply_ai_guidance(
            resident_source_a, curves, guidance.denoise_mix, guidance.detail_mix,
            0.12 * guidance.temporal_mix, None,
        )
        discrete_delivery_a = backend.canonical_delivery(
            discrete_ai_a, "NDR10_PLUS", 0.18, 0.50, NDR_PARAMS
        )
        resident_delivery_a, resident_contract = backend.apply_ai_guidance_resident(
            resident_source_a, curves, guidance.denoise_mix, guidance.detail_mix,
            0.12 * guidance.temporal_mix, reset_temporal=True,
            delivery_mode="NDR10_PLUS", diffuse_reference=0.18,
            warm_skin_red_tame=0.50, delivery_parameters=NDR_PARAMS,
        )
        resident_allocations_after_warmup = backend.describe()["continuum"]["allocationCount"]
        discrete_ai_b = backend.apply_ai_guidance(
            resident_source_b, curves, guidance.denoise_mix, guidance.detail_mix,
            0.12 * guidance.temporal_mix, discrete_ai_a,
        )
        discrete_delivery_b = backend.canonical_delivery(
            discrete_ai_b, "NDR10_PLUS", 0.18, 0.50, NDR_PARAMS
        )
        resident_delivery_b, _ = backend.apply_ai_guidance_resident(
            resident_source_b, curves, guidance.denoise_mix, guidance.detail_mix,
            0.12 * guidance.temporal_mix, delivery_mode="NDR10_PLUS",
            diffuse_reference=0.18, warm_skin_red_tame=0.50,
            delivery_parameters=NDR_PARAMS,
        )
        resident_allocations_after_reuse = backend.describe()["continuum"]["allocationCount"]
        if resident_allocations_after_reuse != resident_allocations_after_warmup:
            raise RuntimeError("Continuum persistent-resource reuse test allocated during steady state")
        continuum_delta = max(
            int(np.max(np.abs(discrete_delivery_a.astype(np.int32) - resident_delivery_a.astype(np.int32)))),
            int(np.max(np.abs(discrete_delivery_b.astype(np.int32) - resident_delivery_b.astype(np.int32)))),
        )

        # Exercise the actual registration/fusion path rather than a synthetic no-op shader.
        base = np.fromfunction(
            lambda y, x, c: 7000 + ((x * 977 + y * 619 + c * 3101) % 42000),
            (32, 48, 3), dtype=np.int32,
        ).astype(np.uint16)
        burst = [base, np.roll(base, 1, axis=1), np.roll(base, -1, axis=1), base.copy()]
        motion_reference = mfsr_proxy(burst[0])
        motion_candidate = mfsr_proxy(burst[1])
        motion_shift = estimate_translation(motion_reference, motion_candidate, 24.0)
        expected_motion = estimate_motion_field(
            motion_reference, motion_candidate, motion_shift[0], motion_shift[1]
        )
        actual_motion = backend.estimate_motion_fields(
            motion_reference, [(motion_candidate, motion_shift[0], motion_shift[1])]
        )[0]
        motion_vector_delta = max(
            float(np.max(np.abs(expected_motion[0] - actual_motion[0]))),
            float(np.max(np.abs(expected_motion[1] - actual_motion[1]))),
        )
        motion_confidence_delta = float(np.max(np.abs(expected_motion[2] - actual_motion[2])))
        if motion_vector_delta != 0.0 or motion_confidence_delta > 1.0e-4:
            raise RuntimeError(
                "GPU motion-field parity failed "
                f"(vector={motion_vector_delta}, confidence={motion_confidence_delta})"
            )
        cpu_mfsr = MotionAwareMfsr(48, 32, 3, 0.62, 0.25, 128)
        gpu_mfsr = MotionAwareMfsr(48, 32, 3, 0.62, 0.25, 128, backend)
        expected_mfsr = actual_mfsr = None
        expected_event = actual_event = None
        for sample in burst:
            expected_mfsr, expected_event = cpu_mfsr.process(sample)
            actual_mfsr, actual_event = gpu_mfsr.process(sample)
        if not expected_event.get("fused") or not actual_event.get("fused"):
            raise RuntimeError("MFSR GPU parity burst did not reach the fusion stage")
        mfsr_delta = int(np.max(np.abs(
            expected_mfsr.astype(np.int32) - actual_mfsr.astype(np.int32)
        )))
        deltas = {
            "canonicalDelivery": delivery_delta,
            "niv99": niv99_delta,
            "continuumNiv99Delivery": niv99_delivery_delta,
            "aiGuidance": guidance_delta,
            "mfsr": mfsr_delta,
            "continuumGraph": continuum_delta,
        }
        if max(deltas.values()) > 1:
            raise RuntimeError(f"GPU parity exceeded one RGB48 code value: {deltas}")
        return {
            "ready": True,
            **backend.describe(),
            "precision": "float32 compute / round-to-nearest RGB48",
            "maximumCodeDelta": max(deltas.values()),
            "kernelDeltas": deltas,
            "motionParity": {
                "maximumVectorDelta": motion_vector_delta,
                "maximumConfidenceDelta": motion_confidence_delta,
            },
            "resourceReuse": {
                "ready": True,
                "steadyStateAllocations": resident_allocations_after_reuse - resident_allocations_after_warmup,
            },
            "kernels": ["MFSR motion registration", "MFSR fusion", "NIV99/OmniClarity",
                        "AI guidance", "NDR/NIVUKX delivery"],
            "frameGraphs": [fused_niv99_event["continuum"], resident_contract],
            "selfTestMs": round((time.perf_counter() - started) * 1000.0, 2),
        }
    except Exception as error:
        return {
            "ready": False,
            "version": GPU_COMPUTE_VERSION,
            "engine": "NumPy CPU fallback",
            "error": str(error),
            "selfTestMs": round((time.perf_counter() - started) * 1000.0, 2),
        }


def inspect_model(model_path: str, onnx_model_path: str, threads: int) -> int:
    model = CameraEnhancementModel(model_path, threads, strength=0.5,
                                   onnx_model_path=onnx_model_path, prefer_gpu=True)
    parity = None
    if model.session is not None:
        reference = CameraEnhancementModel(model_path, threads, strength=0.5, prefer_gpu=False)
        y, x = np.mgrid[0:MODEL_HEIGHT, 0:MODEL_WIDTH]
        sample = np.stack([
            x / max(1, MODEL_WIDTH - 1), y / max(1, MODEL_HEIGHT - 1),
            ((x * 17 + y * 29) % 257) / 256.0,
        ], axis=2).astype(np.float32)[None, ...]
        expected = reference.predict(sample)
        actual = model.predict(sample)
        maximum = float(np.max(np.abs(expected - actual)))
        mean = float(np.mean(np.abs(expected - actual)))
        if maximum > 2.0e-5 or mean > 2.0e-6:
            raise RuntimeError(f"DirectML model parity failed (maximum={maximum}, mean={mean})")
        parity = {"maximumError": maximum, "meanError": mean}
    payload = {
        "ready": True,
        "engine": model.engine,
        "accelerated": model.session is not None,
        "model": "CamX Camera Enhancement Denoise",
        "sha256": model.model_hash,
        "onnxSha256": getattr(model, "onnx_model_hash", None),
        "parity": parity,
        "accelerationError": model.acceleration_error,
        "input": model.input["shape"].tolist(),
        "output": model.output["shape"].tolist(),
    }
    sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
    return 0


def inspect_mfsr() -> int:
    payload = {
        "ready": True,
        "engine": "NumPy CPU",
        "algorithm": MFSR_VERSION,
        "minimumFrames": MFSR_MIN_FRAMES,
        "maximumFrames": MFSR_MAX_FRAMES,
        "precision": "RGB48",
        "outputScale": 1,
        "canonicalDelivery": {
            "ready": True,
            "toneOperator": NDR_TONE_VERSION,
            "calibration": NDR_CALIBRATION_VERSION,
            "engine": NDR_DELIVERY_VERSION,
            "modes": ["NDR10_PLUS", "NIVUKX_VISION"],
            "diffuseWhiteNits": DIFFUSE_WHITE_NITS,
            "peaks": [5000, 10000],
            "dynamicMetadata": {
                "schema": DYNAMIC_METADATA_SCHEMA,
                "tiers": ["T0", "T1", "T2", "T3", "T4", "T5", "T6", "T7"],
                "measuredContentLight": True,
                "appearanceAnalysis": "JZAZBZ_FP64_ANALYSIS",
                "integrity": "SHA256_HASH_CHAIN_UNSIGNED",
            },
        },
        "guardrails": [
            "scene-cut reset",
            "phase-correlation registration",
            "blockwise local-motion refinement",
            "full-frame sub-pixel resampling",
            "heteroscedastic 3-sigma ghost veto",
            "confidence-weighted fusion",
            "bounded native-grid detail recovery",
            "NIV99 scene-adaptive spatial/chroma cleanup",
            "OmniClarity motion-gated Riven detail recovery",
            "memory-limited fail-safe bypass",
        ],
    }
    sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
    return 0


def inspect_acceleration() -> int:
    sys.stdout.write(json.dumps(inspect_gpu_compute(), separators=(",", ":")) + "\n")
    return 0


def _process_stream(args: argparse.Namespace, resources: StreamResourceGuard) -> int:
    if args.width <= 0 or args.height <= 0:
        raise ValueError("Frame dimensions must be positive")
    ai_enabled = not args.no_ai
    if ai_enabled and not args.model:
        raise ValueError("--model is required unless --no-ai is selected")
    if not ai_enabled and not args.mfsr and not args.niv99 and args.delivery_transform == "NONE":
        raise ValueError("No processing stage selected")
    gpu_backend = create_gpu_backend(args.compute_backend)
    resources.gpu_backend = gpu_backend
    if args.compute_backend != "cpu" and gpu_backend is None:
        emit({"event": "gpu-fallback", "stage": "initialization", "message": "No validated hardware compute adapter"})
    model = CameraEnhancementModel(
        args.model, args.threads, args.strength,
        onnx_model_path=args.onnx_model,
        prefer_gpu=args.compute_backend != "cpu",
    ) if ai_enabled else None
    mfsr = MotionAwareMfsr(
        args.width,
        args.height,
        args.mfsr_frames,
        args.mfsr_strength,
        args.mfsr_scene_threshold,
        args.mfsr_memory_mib,
        gpu_backend,
    ) if args.mfsr else None
    niv99 = Niv99Processor(
        args.width,
        args.height,
        args.detail_profile,
        args.signal_family,
        args.quality,
        args.saturation,
        args.warmth,
        args.wb_authority,
        args.riven,
        gpu_backend,
    ) if args.niv99 else None
    quality_cache = QualityInstructionCache(
        args.quality_cache_read,
        args.quality_cache_write,
        args.quality_cache_fingerprint,
        args.quality_cache_frames,
    ) if args.niv99 and args.quality_cache_fingerprint and args.quality_cache_frames > 0 else None
    resources.quality_cache = quality_cache
    frame_bytes = args.width * args.height * 3 * 2
    source = sys.stdin.buffer
    destination = sys.stdout.buffer
    frame_io = BoundedFrameIo(source, destination, frame_bytes, args.io_memory_mib)
    resources.frame_io = frame_io
    guidance: Guidance | None = None
    previous_proxy: np.ndarray | None = None
    previous_frame: np.ndarray | None = None
    frames = 0
    inferences = 0
    continuum_frames = 0
    continuum_fused_delivery_frames = 0
    delivery_metadata = DeliveryMetadataAccumulator(
        args.delivery_transform, args.width, args.height
    ) if args.delivery_transform != "NONE" else None
    started = time.perf_counter()
    emit({
        "event": "ready",
        "engine": model.engine if model is not None else
            (gpu_backend.describe()["engine"] if gpu_backend is not None else "NumPy CPU"),
        "compute": gpu_backend.describe() if gpu_backend is not None else {
            "version": GPU_COMPUTE_VERSION, "engine": "NumPy CPU", "backend": "CPU"
        },
        "continuum": gpu_backend.describe().get("continuum") if gpu_backend is not None else None,
        "sha256": model.model_hash if model is not None else None,
        "mfsr": bool(mfsr and mfsr.enabled),
        "mfsrVersion": MFSR_VERSION if mfsr else None,
        "mfsrFrames": mfsr.active_frames if mfsr else 0,
        "niv99": bool(niv99),
        "niv99Version": NIV99_VERSION if niv99 else None,
        "deliveryTransform": args.delivery_transform,
        "deliveryVersion": NDR_DELIVERY_VERSION if args.delivery_transform != "NONE" else None,
        "toneOperatorVersion": NDR_TONE_VERSION if args.delivery_transform != "NONE" else None,
        "calibrationVersion": NDR_CALIBRATION_VERSION if args.delivery_transform != "NONE" else None,
        "deliveryReference": args.delivery_reference if args.delivery_transform != "NONE" else None,
        "dynamicMetadata": {
            "schema": DYNAMIC_METADATA_SCHEMA,
            "privateTechnology": True,
            "interoperability": "CamX sidecar; no third-party dynamic-HDR certification is claimed",
            "tiers": {
                "T0": {
                    "role": "provenance",
                    "delivery": NDR_DELIVERY_VERSION,
                    "toneOperator": NDR_TONE_VERSION,
                    "calibration": NDR_CALIBRATION_VERSION,
                },
                "T1": {"role": "stream contract and ordered frame timing"},
                "T2": {
                    "role": "front-end and mastering envelope",
                    "primaries": "BT.2020",
                    "transfer": "SMPTE ST 2084",
                    "diffuseWhiteNits": DIFFUSE_WHITE_NITS,
                    "masteringPeakNits": NDR_PARAMS[args.delivery_transform]["peak_nits"],
                },
                "T3": {"role": "JzAzBz scene solve and boundaries"},
                "T4": {"role": "per-frame measured content light and tone anchors"},
                "T5": {"role": "16x16 regional/spatial quality analysis"},
                "T6": {"role": "saliency, detail and highlight guard state"},
                "T7": {"role": "cut-aware temporal state"},
            },
        } if delivery_metadata is not None else None,
        "qualityCache": "hit" if quality_cache and quality_cache.hit else "miss" if quality_cache else "disabled",
        "ioPipeline": {"ordered": True, "depth": frame_io.depth, "memoryMiB": args.io_memory_mib},
    })

    for raw in frame_io.frames():
        frame = np.frombuffer(raw, dtype="<u2").reshape(args.height, args.width, 3)
        processed = frame
        recyclable_stage_buffer: np.ndarray | None = None
        delivery_fused = False
        continuum_frame_ms = 0.0
        mfsr_event = None
        niv99_event = None
        scene_reset = False
        if mfsr is not None:
            processed, mfsr_event = mfsr.process(frame)
            scene_reset = bool(mfsr_event.get("sceneReset"))
            if not np.shares_memory(processed, frame):
                recyclable_stage_buffer = processed
            if frames % 4 == 0 or mfsr_event.get("sceneReset"):
                emit(mfsr_event)

        if niv99 is not None:
            cached_metrics = quality_cache.next(frames) if quality_cache and quality_cache.hit else None
            niv99_delivery = {
                "mode": args.delivery_transform,
                "diffuseReference": args.delivery_reference,
                "warmSkinRedTame": args.warm_skin_red_tame,
                "parameters": NDR_PARAMS,
            } if model is None and args.delivery_transform != "NONE" and gpu_backend is not None else None
            niv99_destination = frame if not np.shares_memory(processed, frame) else None
            processed, niv99_event = niv99.process(
                processed, mfsr_event, cached_metrics, delivery=niv99_delivery,
                destination=niv99_destination,
            )
            scene_reset = scene_reset or bool(niv99_event.get("sceneReset"))
            if niv99_event.get("deliveryFused"):
                delivery_fused = True
                continuum_frame_ms = float(niv99_event.get("processingMs", 0.0))
                continuum_frames += 1
                continuum_fused_delivery_frames += 1
                if frames == 0 or frames % 16 == 0:
                    emit({"event": "continuum", "frame": frames + 1,
                          "processingMs": continuum_frame_ms, **niv99_event["continuum"]})
            if quality_cache and not quality_cache.hit:
                quality_cache.append(frames, niv99_event)
            niv99_event["qualityCache"] = "hit" if cached_metrics is not None else "analyzed"
            # The desktop streams this compact record to a checksummed JSONL companion, so every
            # frame remains auditable without retaining a multi-hour conversion log in memory.
            emit(niv99_event)

        if model is not None:
            proxy = resize_nearest(processed, MODEL_WIDTH, MODEL_HEIGHT).astype(np.float32) / UINT16_MAX
            scene_change = previous_proxy is not None and float(np.mean(np.abs(proxy - previous_proxy))) >= args.scene_threshold
            scene_change = scene_change or bool(mfsr_event and mfsr_event.get("sceneReset"))
            scene_reset = scene_reset or scene_change
            should_infer = guidance is None or scene_change or frames % args.interval == 0
            if should_infer:
                analyzed = model.analyze(proxy)
                guidance = analyzed if guidance is None or scene_change else blend_guidance(guidance, analyzed)
                inferences += 1
            previous_proxy = proxy
            if scene_change:
                previous_frame = None
            if gpu_backend is not None:
                try:
                    continuum_started = time.perf_counter_ns()
                    ai_input = processed
                    processed, continuum_event = gpu_backend.apply_ai_guidance_resident(
                        ai_input, guidance.curves, guidance.denoise_mix, guidance.detail_mix,
                        args.temporal_strength * guidance.temporal_mix,
                        reset_temporal=scene_change,
                        delivery_mode=args.delivery_transform,
                        diffuse_reference=args.delivery_reference,
                        warm_skin_red_tame=args.warm_skin_red_tame,
                        delivery_parameters=NDR_PARAMS,
                        destination=recyclable_stage_buffer,
                        delivery_destination=ai_input if args.delivery_transform != "NONE" else None,
                    )
                    continuum_frame_ms = (time.perf_counter_ns() - continuum_started) / 1_000_000.0
                    continuum_frames += 1
                    delivery_fused = args.delivery_transform != "NONE"
                    continuum_fused_delivery_frames += int(delivery_fused)
                    if frames == 0 or frames % 16 == 0:
                        emit({"event": "continuum", "frame": frames + 1,
                              "processingMs": round(continuum_frame_ms, 4), **continuum_event})
                except Exception as error:
                    emit({"event": "gpu-fallback", "stage": "ai-guidance", "message": error_message(error)})
                    if args.delivery_transform != "NONE" and continuum_frames > 0:
                        raise RuntimeError(
                            "NIVUKX Continuum lost its device-resident temporal state; "
                            "conversion stopped instead of changing image quality"
                        ) from error
                    gpu_backend = None
                    processed = apply_guidance(processed, guidance, previous_frame, args.temporal_strength)
            else:
                processed = apply_guidance(processed, guidance, previous_frame, args.temporal_strength)
            if not delivery_fused:
                previous_frame = processed.copy()

        delivery_started = time.perf_counter_ns()
        delivery_compute = "bypassed"
        if delivery_fused:
            delivery_compute = f"{gpu_backend.describe()['engine']} / {gpu_backend.describe()['continuum']['version']}"
        elif args.delivery_transform != "NONE" and gpu_backend is not None:
            try:
                processed = gpu_backend.canonical_delivery(
                    processed, args.delivery_transform, args.delivery_reference,
                    args.warm_skin_red_tame, NDR_PARAMS,
                )
                delivery_compute = gpu_backend.describe()["engine"]
            except Exception as error:
                emit({"event": "gpu-fallback", "stage": "canonical-delivery", "message": error_message(error)})
                gpu_backend = None
                processed = apply_canonical_delivery(
                    processed, args.delivery_transform, args.delivery_reference, args.warm_skin_red_tame,
                )
                delivery_compute = "NumPy CPU"
        else:
            processed = apply_canonical_delivery(
                processed, args.delivery_transform, args.delivery_reference, args.warm_skin_red_tame,
            )
            if args.delivery_transform != "NONE":
                delivery_compute = "NumPy CPU"
        delivery_ms = continuum_frame_ms if delivery_fused else (time.perf_counter_ns() - delivery_started) / 1_000_000.0
        frame_io.write_frame(processed)
        frames += 1
        if args.delivery_transform != "NONE":
            metadata_event = delivery_metadata.measure(
                processed, scene_reset, mfsr_event, niv99_event, guidance
            )
            emit({
                "event": "delivery",
                "frame": frames,
                "mode": args.delivery_transform,
                "version": NDR_DELIVERY_VERSION,
                "toneOperator": NDR_TONE_VERSION,
                "calibration": NDR_CALIBRATION_VERSION,
                "diffuseWhiteNits": DIFFUSE_WHITE_NITS,
                "peakNits": NDR_PARAMS[args.delivery_transform]["peak_nits"],
                "processingMs": round(delivery_ms, 4),
                "compute": delivery_compute,
                **metadata_event,
            })
        if frames % 8 == 0:
            emit({"event": "progress", "frames": frames, "inferences": inferences})

    frame_io.finish()
    cache_committed = quality_cache.commit(frames) if quality_cache else False
    emit({
        "event": "complete",
        "frames": frames,
        "inferences": inferences,
        "mfsrFusedFrames": mfsr.fused_frames if mfsr else 0,
        "mfsrSceneResets": mfsr.scene_resets if mfsr else 0,
        "mfsrRejectedRegistrations": mfsr.rejected_registrations if mfsr else 0,
        "niv99Frames": niv99.frames if niv99 else 0,
        "niv99TemporalFrames": niv99.temporal_frames if niv99 else 0,
        "niv99RivenFrames": niv99.riven_frames if niv99 else 0,
        "niv99SceneResets": niv99.scene_resets if niv99 else 0,
        "mfsrGpuFrames": mfsr.gpu_frames if mfsr else 0,
        "mfsrGpuFallbacks": mfsr.gpu_fallbacks if mfsr else 0,
        "mfsrGpuMotionBatches": mfsr.gpu_motion_batches if mfsr else 0,
        "mfsrGpuMotionFields": mfsr.gpu_motion_fields if mfsr else 0,
        "mfsrGpuMotionFallbacks": mfsr.gpu_motion_fallbacks if mfsr else 0,
        "niv99GpuFrames": niv99.gpu_frames if niv99 else 0,
        "niv99GpuFallbacks": niv99.gpu_fallbacks if niv99 else 0,
        "niv99AverageNoise": round(niv99.noise_sum / max(1, niv99.frames), 7) if niv99 else 0.0,
        "niv99AverageSeverity": round(niv99.severity_sum / max(1, niv99.frames), 7) if niv99 else 0.0,
        "deliveryTransform": args.delivery_transform,
        "deliveryVersion": NDR_DELIVERY_VERSION if args.delivery_transform != "NONE" else None,
        "measuredContentLight": delivery_metadata.summary() if delivery_metadata is not None else None,
        "continuumFrames": continuum_frames,
        "continuumFusedDeliveryFrames": continuum_fused_delivery_frames,
        "continuum": gpu_backend.describe().get("continuum") if gpu_backend is not None else None,
        "ioPipeline": {"ordered": True, "depth": frame_io.depth, "writtenFrames": frame_io.written_frames},
        "qualityCache": "hit" if quality_cache and quality_cache.hit else "written" if cache_committed else "disabled",
        "seconds": round(time.perf_counter() - started, 3),
    })
    return 0


def process_stream(args: argparse.Namespace) -> int:
    resources = StreamResourceGuard()
    try:
        result = _process_stream(args, resources)
        resources.succeeded = True
        return result
    finally:
        resources.close()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="CamX Studio MFSR and camera-AI enhancement worker")
    parser.add_argument("--model", default="")
    parser.add_argument("--onnx-model", default="")
    parser.add_argument("--inspect", action="store_true")
    parser.add_argument("--inspect-mfsr", action="store_true")
    parser.add_argument("--inspect-acceleration", action="store_true")
    parser.add_argument("--compute-backend", choices=["auto", "gpu", "cpu"], default="auto")
    parser.add_argument("--no-ai", action="store_true")
    parser.add_argument("--mfsr", action="store_true")
    parser.add_argument("--niv99", action="store_true")
    parser.add_argument("--riven", action="store_true")
    parser.add_argument("--width", type=int, default=0)
    parser.add_argument("--height", type=int, default=0)
    parser.add_argument("--threads", type=int, default=max(1, os.cpu_count() or 1))
    parser.add_argument("--strength", type=float, default=0.55)
    parser.add_argument("--interval", type=int, default=12)
    parser.add_argument("--scene-threshold", type=float, default=0.085)
    parser.add_argument("--temporal-strength", type=float, default=0.12)
    parser.add_argument("--mfsr-frames", type=int, default=5)
    parser.add_argument("--mfsr-strength", type=float, default=0.52)
    parser.add_argument("--mfsr-scene-threshold", type=float, default=0.10)
    parser.add_argument("--mfsr-memory-mib", type=int, default=768)
    parser.add_argument("--detail-profile", choices=sorted(DETAIL_TUNING), default="FOCUSED_DETAIL")
    parser.add_argument("--signal-family", choices=["SDR", "HDR", "LOG"], default="SDR")
    parser.add_argument("--quality", choices=["maximum", "production", "accelerated"], default="maximum")
    parser.add_argument("--saturation", type=float, default=1.0)
    parser.add_argument("--warmth", type=float, default=0.0)
    parser.add_argument("--wb-authority", choices=["AUTO", "MANUAL", "LOCKED", "UNKNOWN"], default="UNKNOWN")
    parser.add_argument("--delivery-transform", choices=["NONE", "NDR10_PLUS", "NIVUKX_VISION"], default="NONE")
    parser.add_argument("--delivery-reference", type=float, default=1.0)
    parser.add_argument("--warm-skin-red-tame", type=float, default=0.50)
    parser.add_argument("--quality-cache-read", default="")
    parser.add_argument("--quality-cache-write", default="")
    parser.add_argument("--quality-cache-fingerprint", default="")
    parser.add_argument("--quality-cache-frames", type=int, default=0)
    parser.add_argument("--io-memory-mib", type=int, default=256)
    argv = sys.argv[1:]
    # PyInstaller's Python 3.14 bootloader can expose the executable once more
    # as argv[1]. Ignore that duplicate while preserving normal script usage.
    if argv and argv[0].lower().endswith(".exe"):
        argv = argv[1:]
    args = parser.parse_args(argv)
    args.interval = max(1, args.interval)
    args.temporal_strength = float(np.clip(args.temporal_strength, 0.0, 0.18))
    args.mfsr_frames = int(np.clip(args.mfsr_frames, MFSR_MIN_FRAMES, MFSR_MAX_FRAMES))
    args.mfsr_strength = float(np.clip(args.mfsr_strength, 0.0, 1.0))
    args.mfsr_memory_mib = max(64, args.mfsr_memory_mib)
    args.io_memory_mib = int(np.clip(args.io_memory_mib, 32, 1024))
    args.warm_skin_red_tame = float(np.clip(args.warm_skin_red_tame, 0.0, 1.0))
    if not np.isfinite(args.delivery_reference) or not 0.0 < args.delivery_reference <= 1.0:
        parser.error("--delivery-reference must be finite and in (0,1]")
    return args


def main() -> int:
    args = parse_args()
    if args.inspect_acceleration:
        return inspect_acceleration()
    if args.inspect_mfsr:
        return inspect_mfsr()
    if args.inspect:
        if not args.model:
            raise ValueError("--model is required for --inspect")
        return inspect_model(args.model, args.onnx_model, args.threads)
    return process_stream(args)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except BrokenPipeError:
        raise SystemExit(0)
    except Exception as error:
        emit({"event": "fatal", "message": str(error)})
        raise SystemExit(1)
