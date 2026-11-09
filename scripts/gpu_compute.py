"""Cross-vendor CamX RGB48 compute kernels.

The implementation uses WebGPU's WGSL compute model.  On Windows wgpu-native
selects a real Vulkan or D3D12 adapter (never the software fallback).  Every
kernel accepts the same normalized float32 values used by the NumPy reference
and returns float32 for the existing round-to-nearest RGB48 quantizer.

No kernel is trusted merely because a device exists: ai_worker runs numerical
parity vectors before exposing this backend to the desktop application.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np


GPU_COMPUTE_VERSION = "CAMX-WGSL-COMPUTE-v1"
CONTINUUM_VERSION = "NIVUKX-CONTINUUM-v1"
UINT16_MAX = 65535.0
MAX_SINGLE_PASS_FLOAT_BYTES = 48 * 1024 * 1024
# Keep the transient upload/readback working set small on integrated GPUs.  A
# 4096-wide RGB float tile is ~3 MiB at 64 rows (plus a two-row halo), which
# leaves enough shared memory for the eight-frame packed MFSR ring and the
# hardware encoder.  Tile boundaries are haloed and quantized identically, so
# this changes memory pressure only, not image math.
FULL_WIDTH_TILE_ROWS = 64


class GpuComputeUnavailable(RuntimeError):
    pass


@dataclass(frozen=True)
class GpuIdentity:
    name: str
    vendor: str
    adapter_type: str
    backend_type: str


NIV99_SHADER = r"""
@group(0) @binding(0) var<storage, read> source: array<f32>;
@group(0) @binding(1) var<storage, read_write> destination: array<f32>;
@group(0) @binding(2) var<storage, read> params: array<f32>;
@group(0) @binding(3) var<storage, read> dims: array<u32>;

fn clamp_i(value: i32, low: i32, high: i32) -> i32 {
    return min(high, max(low, value));
}

fn pixel(x: i32, y: i32) -> vec3<f32> {
    let width = i32(dims[0]);
    let height = i32(dims[1]);
    let px = u32(clamp_i(x, 0, width - 1));
    let py = u32(clamp_i(y, 0, height - 1));
    let offset = (py * dims[0] + px) * 3u;
    return vec3<f32>(source[offset], source[offset + 1u], source[offset + 2u]);
}

fn luma(value: vec3<f32>) -> f32 {
    return dot(value, vec3<f32>(0.2126, 0.7152, 0.0722));
}

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) invocation: vec3<u32>) {
    if (invocation.x >= dims[0] || invocation.y >= dims[1]) { return; }
    let x = i32(invocation.x);
    let y = i32(invocation.y);
    let center = pixel(x, y);
    let local = (center * 4.0 + pixel(x, y - 1) + pixel(x, y + 1) +
                 pixel(x - 1, y) + pixel(x + 1, y)) / 8.0;
    let wide = (center * 4.0 + pixel(x, y - 2) + pixel(x, y + 2) +
                pixel(x - 2, y) + pixel(x + 2, y)) / 8.0;
    let center_luma = luma(center);
    let local_luma = luma(local);
    let fine = center - local;
    let structure = center - wide;
    let edge = max(abs(fine.r), max(abs(fine.g), abs(fine.b)));

    let sharp = params[0];
    let denoise = params[1];
    let noise_floor = params[2];
    let edge_gate = clamp(1.0 - edge / max(0.012, noise_floor * 5.5), 0.0, 1.0);
    var refined = center + (local - center) * (denoise * 0.22 * edge_gate);
    let refined_luma = luma(refined);
    let chroma = refined - vec3<f32>(refined_luma);
    let local_chroma = local - vec3<f32>(local_luma);
    let chroma_gate = clamp(1.0 - edge / 0.045, 0.12, 1.0);
    refined = refined - chroma + chroma + (local_chroma - chroma) * (denoise * 0.12 * chroma_gate);

    let texture_gate = clamp((edge - noise_floor * 0.55) / 0.020, 0.0, 1.0);
    let halo_gate = clamp((0.080 - edge) / 0.050, 0.0, 1.0);
    let exposure_gate = clamp((center_luma - 0.018) / 0.080, 0.0, 1.0) *
                        clamp((0.985 - center_luma) / 0.10, 0.0, 1.0);
    let detail_gate = texture_gate * halo_gate * exposure_gate;
    let detail = clamp(fine * (sharp * 0.11) + structure * (params[3] * 0.045),
                       vec3<f32>(-0.0045), vec3<f32>(0.0045));
    refined = refined + detail * detail_gate;

    if (params[7] > 0.5) {
        let dx = i32(params[8]);
        let dy = i32(params[9]);
        let before = pixel(x - dx, y - dy);
        let after = pixel(x + dx, y + dy);
        let motion_detail = center - (before + after) * 0.5;
        let snr_gate = clamp((edge - noise_floor) / 0.030, 0.0, 1.0) * exposure_gate;
        refined = refined + clamp(motion_detail * params[10], vec3<f32>(-0.0025),
                                  vec3<f32>(0.0025)) * snr_gate;
    }

    let final_luma = luma(refined);
    let final_chroma = refined - vec3<f32>(final_luma);
    refined = vec3<f32>(final_luma) + final_chroma * params[4];
    if (abs(params[5]) > 0.000001) {
        let warmth_gate = clamp((final_luma - 0.02) / 0.12, 0.0, 1.0) *
                          clamp((0.96 - final_luma) / 0.16, 0.0, 1.0);
        refined = refined + vec3<f32>(0.55, 0.02, -0.55) * params[5] * 0.035 * warmth_gate;
    }
    refined = min(center + vec3<f32>(params[6]), max(center - vec3<f32>(params[6]), refined));
    refined = clamp(refined, vec3<f32>(0.0), vec3<f32>(1.0));
    let offset = (invocation.y * dims[0] + invocation.x) * 3u;
    destination[offset] = refined.r;
    destination[offset + 1u] = refined.g;
    destination[offset + 2u] = refined.b;
}
"""


DELIVERY_SHADER = r"""
@group(0) @binding(0) var<storage, read> source: array<f32>;
@group(0) @binding(1) var<storage, read_write> destination: array<f32>;
@group(0) @binding(2) var<storage, read> p: array<f32>;
@group(0) @binding(3) var<storage, read> dims: array<u32>;

fn ss(edge0: f32, edge1: f32, value: f32) -> f32 {
    let t = clamp((value - edge0) / (edge1 - edge0), 0.0, 1.0);
    return t * t * (3.0 - 2.0 * t);
}
fn luma(value: vec3<f32>) -> f32 {
    return dot(value, vec3<f32>(0.2627, 0.6780, 0.0593));
}
fn pq(nits: vec3<f32>) -> vec3<f32> {
    let m1 = 2610.0 / 16384.0;
    let m2 = 2523.0 / 32.0;
    let c1 = 3424.0 / 4096.0;
    let c2 = 2413.0 / 128.0;
    let c3 = 2392.0 / 128.0;
    let normalized = clamp(nits / 10000.0, vec3<f32>(0.0), vec3<f32>(1.0));
    let powered = pow(normalized, vec3<f32>(m1));
    return clamp(pow((vec3<f32>(c1) + c2 * powered) /
                     (vec3<f32>(1.0) + c3 * powered), vec3<f32>(m2)),
                 vec3<f32>(0.0), vec3<f32>(1.0));
}

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) invocation: vec3<u32>) {
    if (invocation.x >= dims[0] || invocation.y >= dims[1]) { return; }
    let offset = (invocation.y * dims[0] + invocation.x) * 3u;
    let encoded = vec3<f32>(source[offset], source[offset + 1u], source[offset + 2u]);
    let rgb = max(encoded / p[8], vec3<f32>(0.0));
    let source_luma = max(luma(rgb), 0.00000001);
    var signal: f32;
    if (source_luma <= 1.0) {
        signal = pow(source_luma, p[0]) + ss(0.0, p[1], source_luma) * p[2] * (1.0 - source_luma);
    } else {
        signal = 1.0 + (p[0] - p[2]) * (source_luma - 1.0);
    }
    let lift_window = ss(0.025, 0.20, signal) * (1.0 - ss(0.78, 1.20, signal));
    var lifted = signal;
    if (signal > 0.0 && signal < 1.0) {
        lifted = signal + p[4] * sqrt(max(signal, 0.0)) * (1.0 - signal) * lift_window;
    }
    let contrast_window = ss(0.055, 0.24, lifted) * (1.0 - ss(0.76, 1.0, lifted));
    let signed_contrast = (lifted - 0.50) * 4.0 * lifted * (1.0 - lifted);
    var mapped_luma = lifted;
    if (lifted > 0.0 && lifted < 1.0) {
        mapped_luma = max(0.0, lifted + p[5] * signed_contrast * contrast_window);
    }
    var shaped = rgb * (mapped_luma / source_luma);
    let safe_green = max(rgb.g, 0.00000001);
    let red_green = rgb.r / safe_green;
    let blue_green = rgb.b / safe_green;
    let relative_chroma = (max(shaped.r, max(shaped.g, shaped.b)) -
                           min(shaped.r, min(shaped.g, shaped.b))) / max(mapped_luma, 0.04);
    let color_confidence = ss(0.035, 0.22, relative_chroma);
    let skin = ss(1.02, 1.16, red_green) * (1.0 - ss(1.58, 2.10, red_green)) *
               (1.0 - ss(0.98, 1.18, blue_green));
    let sky = ss(1.03, 1.22, blue_green) * (1.0 - ss(1.00, 1.22, red_green));
    let tonal_window = ss(0.035, 0.16, mapped_luma) * (1.0 - ss(0.88, 1.65, mapped_luma));
    let skin_protection = 1.0 + (0.45 - 1.0) * skin;
    let chroma_gain = 1.0 + (p[6] + p[7] * sky) * color_confidence * tonal_window * skin_protection;
    shaped = vec3<f32>(mapped_luma) + (shaped - vec3<f32>(mapped_luma)) * chroma_gain;
    let desaturation = clamp(p[3] * ss(0.55, 1.0, mapped_luma), 0.0, p[3]);
    shaped = vec3<f32>(mapped_luma) + (shaped - vec3<f32>(mapped_luma)) * (1.0 - desaturation);

    if (p[9] > 0.0) {
        let original_y = max(luma(shaped), 0.00000001);
        let moderate_red = ss(1.18, 1.55, red_green) * (1.0 - ss(2.80, 4.00, red_green));
        let blue_present = ss(0.28, 0.55, blue_green) * (1.0 - ss(1.08, 1.35, blue_green));
        let exposure = ss(0.04, 0.16, mapped_luma) * (1.0 - ss(6.5, 8.0, mapped_luma));
        let red_overflow = ss(1.30, 2.10, red_green);
        let weight = clamp(p[9] * moderate_red * blue_present * exposure *
                           (0.45 + 0.55 * red_overflow), 0.0, p[9]);
        shaped.r = shaped.r + (min(shaped.r, shaped.g * 1.42) - shaped.r) * weight;
        shaped.b = shaped.b + (max(shaped.b, shaped.g * 0.64) - shaped.b) * (weight * 0.68);
        shaped = shaped * (original_y / max(luma(shaped), 0.00000001));
    }

    let signal_luma = luma(shaped);
    let raw_nits = max(signal_luma, 0.0) * 203.0;
    let shoulder_range = p[10] - 203.0;
    var display_nits = raw_nits;
    if (raw_nits > 203.0) {
        display_nits = 203.0 + shoulder_range * (1.0 - exp(-(raw_nits - 203.0) / shoulder_range));
    }
    display_nits = min(display_nits, p[10]);
    var rgb_nits = max(shaped * (display_nits / max(signal_luma, 0.00000001)), vec3<f32>(0.0));
    let high = max(rgb_nits.r, max(rgb_nits.g, rgb_nits.b));
    if (high > p[10] && high > display_nits + 0.00000001) {
        let chroma_scale = clamp((p[10] - display_nits) / (high - display_nits), 0.0, 1.0);
        rgb_nits = vec3<f32>(display_nits) + (rgb_nits - vec3<f32>(display_nits)) * chroma_scale;
    }
    rgb_nits = clamp(rgb_nits, vec3<f32>(0.0), vec3<f32>(p[10]));
    var result = pq(rgb_nits);
    if (signal_luma <= 0.00000001) { result = vec3<f32>(0.0); }
    destination[offset] = result.r;
    destination[offset + 1u] = result.g;
    destination[offset + 2u] = result.b;
}
"""


MFSR_ACCUMULATE_SHADER = r"""
@group(0) @binding(0) var<storage, read> current: array<u32>;
@group(0) @binding(1) var<storage, read> candidate: array<u32>;
@group(0) @binding(2) var<storage, read_write> accumulation: array<f32>;
@group(0) @binding(3) var<storage, read_write> weights: array<f32>;
@group(0) @binding(4) var<storage, read_write> accepted: array<f32>;
@group(0) @binding(5) var<storage, read> fields: array<f32>;
@group(0) @binding(6) var<storage, read> p: array<f32>;
@group(0) @binding(7) var<storage, read> dims: array<u32>;

fn sample(buffer_index: u32, index: u32) -> f32 {
    var word: u32;
    if (buffer_index == 0u) { word = current[index / 2u]; }
    else { word = candidate[index / 2u]; }
    let code = select(word & 65535u, word >> 16u, (index & 1u) == 1u);
    return f32(code) / 65535.0;
}
fn source_pixel(x: u32, y: u32) -> vec3<f32> {
    let offset = (y * dims[0] + x) * 3u;
    return vec3<f32>(sample(1u, offset), sample(1u, offset + 1u), sample(1u, offset + 2u));
}
fn reference_pixel(index: u32) -> vec3<f32> {
    let offset = index * 3u;
    return vec3<f32>(sample(0u, offset), sample(0u, offset + 1u), sample(0u, offset + 2u));
}
fn luma(value: vec3<f32>) -> f32 { return dot(value, vec3<f32>(0.2126, 0.7152, 0.0722)); }
fn field_value(base: u32, x: u32, y: u32, columns: u32) -> f32 { return fields[base + y * columns + x]; }

fn interpolated_field(base: u32, px: u32, py: u32, columns: u32, rows: u32) -> f32 {
    let gx = select(0.0, f32(px) * f32(columns - 1u) / f32(dims[0] - 1u), dims[0] > 1u);
    let gy = select(0.0, f32(py) * f32(rows - 1u) / f32(dims[1] - 1u), dims[1] > 1u);
    let x0 = u32(floor(gx)); let y0 = u32(floor(gy));
    let x1 = min(x0 + 1u, columns - 1u); let y1 = min(y0 + 1u, rows - 1u);
    let fx = gx - f32(x0); let fy = gy - f32(y0);
    let top = field_value(base, x0, y0, columns) * (1.0 - fx) + field_value(base, x1, y0, columns) * fx;
    let bottom = field_value(base, x0, y1, columns) * (1.0 - fx) + field_value(base, x1, y1, columns) * fx;
    return top * (1.0 - fy) + bottom * fy;
}

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) invocation: vec3<u32>) {
    if (invocation.x >= dims[0] || invocation.y >= dims[1]) { return; }
    let index = invocation.y * dims[0] + invocation.x;
    let columns = u32(p[4]); let rows = u32(p[5]); let field_size = columns * rows;
    let field_base = u32(p[6]) * field_size * 3u;
    let shift_x = interpolated_field(field_base, invocation.x, invocation.y, columns, rows) * p[7];
    let shift_y = interpolated_field(field_base + field_size, invocation.x, invocation.y, columns, rows) * p[8];
    let local_confidence = interpolated_field(field_base + field_size * 2u, invocation.x, invocation.y, columns, rows);
    let sx = f32(invocation.x) - shift_x; let sy = f32(invocation.y) - shift_y;
    let valid = sx >= 0.0 && sx <= f32(dims[0] - 1u) && sy >= 0.0 && sy <= f32(dims[1] - 1u);
    let bounded_x = clamp(sx, 0.0, f32(dims[0] - 1u));
    let bounded_y = clamp(sy, 0.0, f32(dims[1] - 1u));
    let x0 = u32(floor(bounded_x)); let y0 = u32(floor(bounded_y));
    let x1 = min(x0 + 1u, dims[0] - 1u); let y1 = min(y0 + 1u, dims[1] - 1u);
    let fx = sx - f32(x0); let fy = sy - f32(y0);
    let top = source_pixel(x0, y0) * (1.0 - fx) + source_pixel(x1, y0) * fx;
    let bottom = source_pixel(x0, y1) * (1.0 - fx) + source_pixel(x1, y1) * fx;
    let aligned = top * (1.0 - fy) + bottom * fy;
    let reference = reference_pixel(index);
    let reference_luma = luma(reference); let aligned_luma = luma(aligned);
    let sigma = 3.0 * sqrt(max(p[2] * reference_luma + p[3], 0.00000001));
    let luma_delta = abs(aligned_luma - reference_luma);
    let delta = abs(aligned - reference);
    let color_delta = max(delta.r, max(delta.g, delta.b));
    let ghost = luma_delta > sigma + 0.0025 || color_delta > sigma * 1.8 + 0.004;
    let similarity = exp(-0.5 * pow(luma_delta / max(sigma, 0.0001), 2.0));
    var weight = 0.0;
    if (valid && !ghost) { weight = p[0] * p[1] * local_confidence * similarity; }
    let offset = index * 3u;
    accumulation[offset] = accumulation[offset] + aligned.r * weight;
    accumulation[offset + 1u] = accumulation[offset + 1u] + aligned.g * weight;
    accumulation[offset + 2u] = accumulation[offset + 2u] + aligned.b * weight;
    weights[index] = weights[index] + weight;
    if (weight > 0.02) { accepted[index] = accepted[index] + 1.0; }
}
"""


MFSR_INITIALIZE_SHADER = r"""
@group(0) @binding(0) var<storage, read> current: array<u32>;
@group(0) @binding(1) var<storage, read_write> accumulation: array<f32>;
@group(0) @binding(2) var<storage, read_write> weights: array<f32>;
@group(0) @binding(3) var<storage, read_write> accepted: array<f32>;
@group(0) @binding(4) var<storage, read> dims: array<u32>;

fn sample(index: u32) -> f32 {
    let word = current[index / 2u];
    let code = select(word & 65535u, word >> 16u, (index & 1u) == 1u);
    return f32(code) / 65535.0;
}

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) invocation: vec3<u32>) {
    if (invocation.x >= dims[0] || invocation.y >= dims[1]) { return; }
    let index = invocation.y * dims[0] + invocation.x;
    let offset = index * 3u;
    accumulation[offset] = sample(offset);
    accumulation[offset + 1u] = sample(offset + 1u);
    accumulation[offset + 2u] = sample(offset + 2u);
    weights[index] = 1.0;
    accepted[index] = 0.0;
}
"""


MFSR_MOTION_SEARCH_SHADER = r"""
@group(0) @binding(0) var<storage, read> reference: array<f32>;
@group(0) @binding(1) var<storage, read> candidates: array<f32>;
@group(0) @binding(2) var<storage, read_write> fields: array<f32>;
@group(0) @binding(3) var<storage, read> p: array<i32>;

@compute @workgroup_size(1, 1, 1)
fn main(@builtin(global_invocation_id) invocation: vec3<u32>) {
    let width = p[0]; let height = p[1];
    let columns = p[2]; let rows = p[3]; let radius = p[4];
    let gx = i32(invocation.x); let gy = i32(invocation.y); let candidate_id = i32(invocation.z);
    if (gx >= columns || gy >= rows || candidate_id >= p[5]) { return; }
    let grid_size = columns * rows;
    let field_base = candidate_id * grid_size * 3;
    let field_index = gy * columns + gx;
    let pixel_count = width * height;
    let candidate_base = candidate_id * pixel_count;
    let base_x = p[6 + candidate_id * 2];
    let base_y = p[7 + candidate_id * 2];
    let x0 = gx * width / columns; let x1 = (gx + 1) * width / columns;
    let y0 = gy * height / rows; let y1 = (gy + 1) * height / rows;
    var best = 1.0e30; var second = 1.0e30;
    var best_x = base_x; var best_y = base_y; var scores = 0;
    for (var dy = base_y - radius; dy <= base_y + radius; dy = dy + 1) {
        for (var dx = base_x - radius; dx <= base_x + radius; dx = dx + 1) {
            let rx0 = max(x0, dx); let rx1 = min(x1, width + dx);
            let ry0 = max(y0, dy); let ry1 = min(y1, height + dy);
            if (rx1 - rx0 < 6 || ry1 - ry0 < 6) { continue; }
            var total = 0.0; var count = 0;
            for (var py = ry0; py < ry1; py = py + 1) {
                for (var px = rx0; px < rx1; px = px + 1) {
                    let reference_index = py * width + px;
                    let candidate_index = candidate_base + (py - dy) * width + (px - dx);
                    total = total + abs(reference[u32(reference_index)] - candidates[u32(candidate_index)]);
                    count = count + 1;
                }
            }
            let cost = total / f32(count);
            scores = scores + 1;
            if (cost < best) {
                second = best; best = cost; best_x = dx; best_y = dy;
            } else if (cost < second) {
                second = cost;
            }
        }
    }
    var confidence = 0.0;
    if (scores > 0) {
        if (scores == 1) { second = best + 1.0e-6; }
        let uniqueness = clamp((second - best) / max(second, 1.0e-6), 0.0, 1.0);
        let absolute_confidence = clamp(1.0 - best / 0.065, 0.0, 1.0);
        confidence = uniqueness * 0.65 + absolute_confidence * 0.35;
    }
    fields[u32(field_base + field_index)] = f32(best_x);
    fields[u32(field_base + grid_size + field_index)] = f32(best_y);
    fields[u32(field_base + grid_size * 2 + field_index)] = confidence;
}
"""


MFSR_MOTION_SMOOTH_SHADER = r"""
@group(0) @binding(0) var<storage, read> source: array<f32>;
@group(0) @binding(1) var<storage, read_write> destination: array<f32>;
@group(0) @binding(2) var<storage, read> p: array<i32>;

fn median5(a: f32, b: f32, c: f32, d: f32, e: f32) -> f32 {
    var values = array<f32, 5>(a, b, c, d, e);
    for (var i = 1; i < 5; i = i + 1) {
        let key = values[i];
        var j = i;
        while (j > 0 && values[j - 1] > key) {
            values[j] = values[j - 1];
            j = j - 1;
        }
        values[j] = key;
    }
    return values[2];
}

@compute @workgroup_size(1, 1, 1)
fn main(@builtin(global_invocation_id) invocation: vec3<u32>) {
    let columns = p[2]; let rows = p[3]; let candidate_count = p[5];
    let gx = i32(invocation.x); let gy = i32(invocation.y); let candidate_id = i32(invocation.z);
    if (gx >= columns || gy >= rows || candidate_id >= candidate_count) { return; }
    let grid_size = columns * rows;
    let base = candidate_id * grid_size * 3;
    let index = gy * columns + gx;
    let upper = max(0, gy - 1) * columns + gx;
    let lower = min(rows - 1, gy + 1) * columns + gx;
    let left = gy * columns + max(0, gx - 1);
    let right = gy * columns + min(columns - 1, gx + 1);
    for (var plane = 0; plane < 2; plane = plane + 1) {
        let offset = base + plane * grid_size;
        destination[u32(offset + index)] = median5(
            source[u32(offset + index)], source[u32(offset + upper)], source[u32(offset + lower)],
            source[u32(offset + left)], source[u32(offset + right)]
        );
    }
    destination[u32(base + grid_size * 2 + index)] = source[u32(base + grid_size * 2 + index)];
}
"""


MFSR_FINALIZE_SHADER = r"""
@group(0) @binding(0) var<storage, read> current: array<u32>;
@group(0) @binding(1) var<storage, read> accumulation: array<f32>;
@group(0) @binding(2) var<storage, read> weights: array<f32>;
@group(0) @binding(3) var<storage, read> accepted: array<f32>;
@group(0) @binding(4) var<storage, read_write> destination: array<f32>;
@group(0) @binding(5) var<storage, read> p: array<f32>;
@group(0) @binding(6) var<storage, read> dims: array<u32>;
@group(0) @binding(7) var<storage, read_write> totals: array<atomic<u32>>;

fn fused(x: u32, y: u32) -> vec3<f32> {
    let index = y * dims[0] + x; let offset = index * 3u;
    return vec3<f32>(accumulation[offset], accumulation[offset + 1u], accumulation[offset + 2u]) / weights[index];
}
fn current_luma(index: u32) -> f32 {
    let offset = index * 3u;
    let word0 = current[offset / 2u];
    let word1 = current[(offset + 1u) / 2u];
    let word2 = current[(offset + 2u) / 2u];
    let code0 = select(word0 & 65535u, word0 >> 16u, (offset & 1u) == 1u);
    let code1 = select(word1 & 65535u, word1 >> 16u, ((offset + 1u) & 1u) == 1u);
    let code2 = select(word2 & 65535u, word2 >> 16u, ((offset + 2u) & 1u) == 1u);
    return dot(vec3<f32>(f32(code0), f32(code1), f32(code2)) / 65535.0,
               vec3<f32>(0.2126, 0.7152, 0.0722));
}

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) invocation: vec3<u32>) {
    if (invocation.x >= dims[0] || invocation.y >= dims[1]) { return; }
    let x = invocation.x; let y = invocation.y; let index = y * dims[0] + x;
    let strip_start = (y / 64u) * 64u;
    let strip_end = min(strip_start + 64u, dims[1]);
    let upper_y = max(y, strip_start + 1u) - 1u;
    let lower_y = min(y + 1u, strip_end - 1u);
    let left_x = max(x, 1u) - 1u;
    let right_x = min(x + 1u, dims[0] - 1u);
    let center = fused(x, y);
    let local = (center * 4.0 + fused(x, upper_y) + fused(x, lower_y) +
                 fused(left_x, y) + fused(right_x, y)) / 8.0;
    let consensus = clamp(accepted[index] / max(1.0, p[1]), 0.0, 1.0);
    let reference_luma = current_luma(index);
    let exposure = clamp((reference_luma - 0.015) / 0.08, 0.0, 1.0) *
                   clamp((0.985 - reference_luma) / 0.10, 0.0, 1.0);
    let detail = clamp((center - local) * (0.14 * p[0]), vec3<f32>(-0.0025), vec3<f32>(0.0025));
    let reconstructed = clamp(center + detail * (consensus * exposure), vec3<f32>(0.0), vec3<f32>(1.0));
    let offset = index * 3u;
    destination[offset] = reconstructed.r;
    destination[offset + 1u] = reconstructed.g;
    destination[offset + 2u] = reconstructed.b;
    atomicAdd(&totals[0], u32(round(accepted[index])));
}
"""


AI_GUIDANCE_SHADER = r"""
@group(0) @binding(0) var<storage, read> source: array<f32>;
@group(0) @binding(1) var<storage, read> previous: array<f32>;
@group(0) @binding(2) var<storage, read> curves: array<f32>;
@group(0) @binding(3) var<storage, read_write> destination: array<f32>;
@group(0) @binding(4) var<storage, read> p: array<f32>;
@group(0) @binding(5) var<storage, read> dims: array<u32>;

fn pixel(buffer_index: u32, x: i32, y: i32) -> vec3<f32> {
    let px = u32(clamp(x, 0, i32(dims[0]) - 1));
    let py = u32(clamp(y, 0, i32(dims[1]) - 1));
    let offset = (py * dims[0] + px) * 3u;
    if (buffer_index == 0u) {
        return vec3<f32>(source[offset], source[offset + 1u], source[offset + 2u]);
    }
    return vec3<f32>(previous[offset], previous[offset + 1u], previous[offset + 2u]);
}

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) invocation: vec3<u32>) {
    if (invocation.x >= dims[0] || invocation.y >= dims[1]) { return; }
    let x = i32(invocation.x); let y = i32(invocation.y);
    let center = pixel(0u, x, y);
    let local = (center * 4.0 + pixel(0u, x, y - 1) + pixel(0u, x, y + 1) +
                 pixel(0u, x - 1, y) + pixel(0u, x + 1, y)) / 8.0;
    let difference = abs(center - local);
    let detail = max(difference.r, max(difference.g, difference.b));
    let edge_gate = clamp(1.0 - detail / 0.035, 0.0, 1.0);
    var refined = center + (local - center) * (p[0] * edge_gate);
    let texture_gate = clamp((detail - 0.0015) / 0.012, 0.0, 1.0) *
                       clamp((0.055 - detail) / 0.025, 0.0, 1.0);
    let luminance = dot(center, vec3<f32>(0.2126, 0.7152, 0.0722));
    let exposure_gate = clamp((luminance - 0.025) / 0.075, 0.0, 1.0) *
                        clamp((0.94 - luminance) / 0.12, 0.0, 1.0);
    let detail_boost = clamp((center - local) * (p[1] * texture_gate * exposure_gate),
                             vec3<f32>(-0.0035), vec3<f32>(0.0035));
    refined = refined + detail_boost;
    if (p[3] > 0.5 && p[2] > 0.0) {
        let old = pixel(1u, x, y);
        let motion_delta = abs(center - old);
        let motion = max(motion_delta.r, max(motion_delta.g, motion_delta.b));
        let motion_gate = pow(clamp(1.0 - motion / 0.024, 0.0, 1.0), 2.0);
        refined = refined * (1.0 - p[2] * motion_gate) + old * (p[2] * motion_gate);
    }
    let bins = min(vec3<u32>(round(center * 65535.0)) >> vec3<u32>(8u), vec3<u32>(255u));
    let tonal_gate = clamp((vec3<f32>(0.985) - center) / 0.08, vec3<f32>(0.0), vec3<f32>(1.0));
    refined.r = refined.r + curves[bins.r] * tonal_gate.r;
    refined.g = refined.g + curves[256u + bins.g] * tonal_gate.g;
    refined.b = refined.b + curves[512u + bins.b] * tonal_gate.b;
    refined = clamp(refined, vec3<f32>(0.0), vec3<f32>(1.0));
    let offset = (invocation.y * dims[0] + invocation.x) * 3u;
    destination[offset] = refined.r;
    destination[offset + 1u] = refined.g;
    destination[offset + 2u] = refined.b;
}
"""


RGB48_QUANTIZE_SHADER = r"""
@group(0) @binding(0) var<storage, read> source: array<f32>;
@group(0) @binding(1) var<storage, read_write> destination: array<f32>;
@group(0) @binding(2) var<storage, read> dims: array<u32>;

@compute @workgroup_size(256, 1, 1)
fn main(@builtin(global_invocation_id) invocation: vec3<u32>) {
    let sample_count = dims[0] * dims[1] * 3u;
    // WebGPU limits each dispatch dimension to 65,535 workgroups. Flatten a
    // two-dimensional dispatch so 4K+ RGB rasters do not exceed the X limit.
    let index = invocation.x + invocation.y * 65535u * 256u;
    if (index >= sample_count) { return; }
    destination[index] = round(clamp(source[index], 0.0, 1.0) * 65535.0) / 65535.0;
}
"""


class WgpuComputeBackend:
    """Parity-gated WebGPU backend with persistent resources.

    NIVUKX Continuum keeps pipeline objects, bind groups, working buffers and the
    temporal MFSR ring alive for the duration of a conversion.  A frame graph can
    encode several dependent kernels into one submission and performs a readback
    only at an externally visible RGB48 boundary.
    """

    def __init__(self) -> None:
        try:
            import wgpu
        except Exception as error:  # pragma: no cover - exercised in packaged fallback tests
            raise GpuComputeUnavailable(f"WebGPU runtime unavailable: {error}") from error
        self.wgpu = wgpu
        try:
            self.adapter = wgpu.gpu.request_adapter_sync(
                power_preference="high-performance", force_fallback_adapter=False
            )
            if self.adapter is None:
                raise RuntimeError("no hardware adapter")
            info = dict(self.adapter.info)
            if str(info.get("adapter_type", "")).lower() == "cpu":
                raise RuntimeError("software adapter rejected")
            self.device = self.adapter.request_device_sync(label="CamX RGB48 compute")
        except Exception as error:
            raise GpuComputeUnavailable(f"GPU device initialization failed: {error}") from error
        self.identity = GpuIdentity(
            name=str(info.get("device") or info.get("description") or "Unknown GPU"),
            vendor=str(info.get("vendor") or "Unknown vendor"),
            adapter_type=str(info.get("adapter_type") or "Unknown"),
            backend_type=str(info.get("backend_type") or "Unknown"),
        )
        self._pipelines: dict[str, Any] = {}
        self._buffers: dict[str, tuple[int, int, Any]] = {}
        self._upload_signatures: dict[str, bytes] = {}
        self._bind_groups: dict[tuple[int, tuple[int, ...]], Any] = {}
        self._mfsr_shape: tuple[int, int, int] | None = None
        self._mfsr_sequence = 0
        self._mfsr_tokens: list[int | None] = [None] * 8
        self._last_mfsr_graph: dict | None = None
        self._continuum_previous_shape: tuple[int, int, int] | None = None
        self._continuum_previous_valid = False
        self._tiled_ai_previous: np.ndarray | None = None
        self._allocation_count = 0
        self._submission_count = 0
        self._readback_count = 0
        self._upload_count = 0
        self._uploaded_bytes = 0
        self._readback_bytes = 0

    def describe(self) -> dict:
        return {
            "version": GPU_COMPUTE_VERSION,
            "engine": f"WebGPU/WGSL {self.identity.backend_type}",
            "adapter": self.identity.name,
            "vendor": self.identity.vendor,
            "adapterType": self.identity.adapter_type,
            "backend": self.identity.backend_type,
            "continuum": {
                "version": CONTINUUM_VERSION,
                "deviceResident": True,
                "persistentResources": True,
                "batchedMfsrSubmission": True,
                "residentTemporalState": True,
                "packedRgb48TemporalRing": True,
                "allocationCount": self._allocation_count,
                "submissionCount": self._submission_count,
                "readbackCount": self._readback_count,
                "uploadCount": self._upload_count,
                "uploadedBytes": self._uploaded_bytes,
                "readbackBytes": self._readback_bytes,
                "lastMfsrGraph": self._last_mfsr_graph,
            },
        }

    def close(self) -> None:
        for _size, _usage, buffer in self._buffers.values():
            try:
                buffer.destroy()
            except Exception:
                pass
        self._buffers.clear()
        self._bind_groups.clear()
        self._upload_signatures.clear()
        self._mfsr_tokens = [None] * len(self._mfsr_tokens)
        self._continuum_previous_valid = False
        self._tiled_ai_previous = None

    def __del__(self):  # pragma: no cover - process teardown is runtime-specific
        try:
            self.close()
        except Exception:
            pass

    def _pipeline(self, name: str, shader: str):
        cached = self._pipelines.get(name)
        if cached is not None:
            return cached
        module = self.device.create_shader_module(label=f"CamX {name}", code=shader)
        pipeline = self.device.create_compute_pipeline(
            label=f"CamX {name}", layout="auto", compute={"module": module, "entry_point": "main"}
        )
        self._pipelines[name] = pipeline
        return pipeline

    def _persistent(self, key: str, byte_size: int, usage: int, label: str):
        size = max(4, int(byte_size))
        flags = int(usage)
        cached = self._buffers.get(key)
        if cached is not None and cached[0] == size and cached[1] == flags:
            return cached[2]
        if cached is not None:
            cached[2].destroy()
            self._bind_groups.clear()
            self._upload_signatures.pop(key, None)
        buffer = self.device.create_buffer(label=label, size=size, usage=usage)
        self._buffers[key] = (size, flags, buffer)
        self._allocation_count += 1
        return buffer

    def _upload(self, key: str, data: np.ndarray, usage: int, label: str, *, force: bool = False):
        contiguous = np.ascontiguousarray(data)
        buffer = self._persistent(
            key, contiguous.nbytes, usage | self.wgpu.BufferUsage.COPY_DST, label
        )
        signature = contiguous.tobytes() if contiguous.nbytes <= 4096 else None
        if not force and signature is not None and self._upload_signatures.get(key) == signature:
            return buffer
        self.device.queue.write_buffer(buffer, 0, contiguous)
        if signature is not None:
            self._upload_signatures[key] = signature
        self._upload_count += 1
        self._uploaded_bytes += contiguous.nbytes
        return buffer

    def _empty(self, key: str, byte_size: int, usage: int, label: str):
        return self._persistent(key, byte_size, usage, label)

    def _bind_group(self, pipeline, buffers: list, label: str):
        key = (id(pipeline), tuple(id(buffer) for buffer in buffers))
        cached = self._bind_groups.get(key)
        if cached is not None:
            return cached
        entries = [
            {"binding": index, "resource": {"buffer": buffer, "offset": 0, "size": buffer.size}}
            for index, buffer in enumerate(buffers)
        ]
        group = self.device.create_bind_group(
            label=label, layout=pipeline.get_bind_group_layout(0), entries=entries
        )
        self._bind_groups[key] = group
        return group

    def _encode_dispatch(self, encoder, pipeline, buffers: list, dispatch: tuple[int, int, int], label: str) -> None:
        group = self._bind_group(pipeline, buffers, f"{label} bindings")
        compute = encoder.begin_compute_pass(label="CamX compute pass")
        compute.set_pipeline(pipeline)
        compute.set_bind_group(0, group)
        compute.dispatch_workgroups(*dispatch)
        compute.end()

    def _submit(self, encoder) -> None:
        self.device.queue.submit([encoder.finish()])
        self._submission_count += 1

    def _dispatch(self, pipeline, buffers: list, width: int, height: int) -> None:
        encoder = self.device.create_command_encoder(label="NIVUKX Continuum commands")
        self._encode_dispatch(
            encoder, pipeline, buffers, ((width + 15) // 16, (height + 15) // 16, 1),
            "CamX compute",
        )
        self._submit(encoder)

    def _read(self, buffer, size: int | None = None, offset: int = 0) -> memoryview:
        result = self.device.queue.read_buffer(buffer, int(offset), size)
        actual_size = int(size if size is not None else buffer.size)
        self._readback_count += 1
        self._readback_bytes += actual_size
        return result

    def _read_quantized_rgb48(self, buffer, shape: tuple[int, int, int]) -> np.ndarray:
        """Read a float GPU image in bounded strips and quantize to RGB48.

        A single 4096x3072 float readback is 144 MiB and wgpu must stage that
        allocation before NumPy can quantize it.  Reading complete rows keeps
        the peak host allocation bounded while preserving the exact same
        round-to-nearest result and full-resolution output.
        """
        height, width, channels = shape
        output = np.empty(shape, dtype="<u2")
        row_bytes = width * channels * np.dtype(np.float32).itemsize
        for start in range(0, height, FULL_WIDTH_TILE_ROWS):
            end = min(height, start + FULL_WIDTH_TILE_ROWS)
            byte_count = (end - start) * row_bytes
            values = np.frombuffer(
                self._read(buffer, byte_count, start * row_bytes), dtype=np.float32
            )
            output[start:end] = self._quantize(values, (end - start, width, channels))
        return output

    def _quantize_dispatch(self, encoder, source, destination, dims_buffer, width: int, height: int) -> None:
        sample_count = width * height * 3
        workgroups = (sample_count + 255) // 256
        dispatch_x = min(65535, workgroups)
        dispatch_y = (workgroups + 65534) // 65535
        self._encode_dispatch(
            encoder,
            self._pipeline("RGB48 quantize", RGB48_QUANTIZE_SHADER),
            [source, destination, dims_buffer],
            (dispatch_x, dispatch_y, 1),
            "RGB48 quantize",
        )

    @staticmethod
    def _quantize(values: np.ndarray, shape: tuple[int, int, int]) -> np.ndarray:
        return np.clip(np.rint(values.reshape(shape) * UINT16_MAX), 0, 65535).astype("<u2")

    @staticmethod
    def _pack_rgb48(frame_u16: np.ndarray) -> np.ndarray:
        samples = np.ascontiguousarray(frame_u16, dtype="<u2").reshape(-1)
        if samples.size % 2 == 0:
            return samples.view("<u4")
        padded = np.zeros(samples.size + 1, dtype="<u2")
        padded[:-1] = samples
        return padded.view("<u4")

    @staticmethod
    def _padded_rows(frame: np.ndarray, start: int, end: int, halo: int) -> np.ndarray:
        raw_start = max(0, start - halo)
        raw_end = min(frame.shape[0], end + halo)
        strip = frame[raw_start:raw_end]
        before = halo - (start - raw_start)
        after = halo - (raw_end - end)
        if before or after:
            strip = np.pad(strip, ((before, after), (0, 0), (0, 0)), mode="edge")
        return np.ascontiguousarray(strip)

    @staticmethod
    def _rgb48_destination(frame_u16: np.ndarray, destination: np.ndarray | None) -> np.ndarray:
        """Return a separate writable RGB48 destination, reusing caller storage when safe."""
        if destination is None:
            return np.empty_like(frame_u16)
        if (destination.shape != frame_u16.shape or destination.dtype != frame_u16.dtype or
                not destination.flags.c_contiguous or not destination.flags.writeable or
                np.shares_memory(destination, frame_u16)):
            return np.empty_like(frame_u16)
        return destination

    def canonical_delivery(self, frame_u16: np.ndarray, mode: str, diffuse_reference: float,
                           warm_skin_red_tame: float, parameters: dict[str, dict],
                           destination: np.ndarray | None = None) -> np.ndarray:
        if frame_u16.size * np.dtype(np.float32).itemsize <= MAX_SINGLE_PASS_FLOAT_BYTES:
            developed = self._canonical_delivery_frame(
                frame_u16, mode, diffuse_reference, warm_skin_red_tame, parameters
            )
            if destination is not None and not np.shares_memory(destination, frame_u16):
                output = self._rgb48_destination(frame_u16, destination)
                output[...] = developed
                return output
            return developed
        output = self._rgb48_destination(frame_u16, destination)
        for start in range(0, frame_u16.shape[0], FULL_WIDTH_TILE_ROWS):
            end = min(frame_u16.shape[0], start + FULL_WIDTH_TILE_ROWS)
            output[start:end] = self._canonical_delivery_frame(
                np.ascontiguousarray(frame_u16[start:end]),
                mode, diffuse_reference, warm_skin_red_tame, parameters,
            )
        return output

    def _canonical_delivery_frame(self, frame_u16: np.ndarray, mode: str, diffuse_reference: float,
                                  warm_skin_red_tame: float, parameters: dict[str, dict]) -> np.ndarray:
        config = parameters[mode]
        height, width = frame_u16.shape[:2]
        source = np.ascontiguousarray(frame_u16.astype(np.float32).reshape(-1) / UINT16_MAX)
        values = np.array([
            config["gamma"], config["toe_width"], config["toe_amount"], config["desat"],
            config["shadow_lift"], config["contrast"], config["chroma_boost"], config["sky_bonus"],
            diffuse_reference, warm_skin_red_tame, config["peak_nits"],
        ], dtype=np.float32)
        dims = np.array([width, height], dtype=np.uint32)
        usage = self.wgpu.BufferUsage
        input_buffer = self._upload("delivery-input", source, usage.STORAGE, "CamX delivery input")
        output_buffer = self._empty(
            "delivery-output", source.nbytes, usage.STORAGE | usage.COPY_SRC, "CamX delivery output"
        )
        params_buffer = self._upload(
            "delivery-parameters", values, usage.STORAGE, "CamX delivery parameters"
        )
        dims_buffer = self._upload("frame-dimensions", dims, usage.STORAGE, "CamX frame dimensions")
        self._dispatch(self._pipeline("canonical delivery", DELIVERY_SHADER),
                       [input_buffer, output_buffer, params_buffer, dims_buffer], width, height)
        result = np.frombuffer(self._read(output_buffer), dtype=np.float32).copy()
        return self._quantize(result, frame_u16.shape)

    def niv99(self, frame_u16: np.ndarray, *, sharp: float, denoise: float, micro: float,
              noise_floor: float, saturation: float, warmth: float, budget: float,
              motion: dict | None, delivery_mode: str = "NONE",
              diffuse_reference: float = 0.18, warm_skin_red_tame: float = 0.50,
              delivery_parameters: dict[str, dict] | None = None,
              destination: np.ndarray | None = None) -> tuple[np.ndarray, bool]:
        if frame_u16.size * np.dtype(np.float32).itemsize > MAX_SINGLE_PASS_FLOAT_BYTES:
            output = self._rgb48_destination(frame_u16, destination)
            any_riven = False
            for start in range(0, frame_u16.shape[0], FULL_WIDTH_TILE_ROWS):
                end = min(frame_u16.shape[0], start + FULL_WIDTH_TILE_ROWS)
                strip = self._padded_rows(frame_u16, start, end, 2)
                developed, riven_applied = self._niv99_frame(
                    strip, sharp=sharp, denoise=denoise, micro=micro,
                    noise_floor=noise_floor, saturation=saturation, warmth=warmth,
                    budget=budget, motion=motion, delivery_mode=delivery_mode,
                    diffuse_reference=diffuse_reference,
                    warm_skin_red_tame=warm_skin_red_tame,
                    delivery_parameters=delivery_parameters,
                )
                output[start:end] = developed[2:2 + end - start]
                any_riven = any_riven or riven_applied
            return output, any_riven
        developed, riven_applied = self._niv99_frame(
            frame_u16, sharp=sharp, denoise=denoise, micro=micro,
            noise_floor=noise_floor, saturation=saturation, warmth=warmth,
            budget=budget, motion=motion, delivery_mode=delivery_mode,
            diffuse_reference=diffuse_reference,
            warm_skin_red_tame=warm_skin_red_tame,
            delivery_parameters=delivery_parameters,
        )
        if destination is not None and not np.shares_memory(destination, frame_u16):
            output = self._rgb48_destination(frame_u16, destination)
            output[...] = developed
            return output, riven_applied
        return developed, riven_applied

    def _niv99_frame(self, frame_u16: np.ndarray, *, sharp: float, denoise: float, micro: float,
                     noise_floor: float, saturation: float, warmth: float, budget: float,
                     motion: dict | None, delivery_mode: str = "NONE",
                     diffuse_reference: float = 0.18, warm_skin_red_tame: float = 0.50,
                     delivery_parameters: dict[str, dict] | None = None) -> tuple[np.ndarray, bool]:
        height, width = frame_u16.shape[:2]
        riven_applied = False
        dx = dy = 0
        motion_amount = 0.0
        if motion and motion.get("fused") and float(motion.get("confidence", 0.0)) >= 0.20:
            shift_x = float(motion.get("meanShiftX", 0.0))
            shift_y = float(motion.get("meanShiftY", 0.0))
            magnitude = float(np.hypot(shift_x, shift_y))
            if 0.30 <= magnitude <= 8.0:
                dx = int(np.clip(round(shift_x / max(magnitude, 1.0)), -1, 1))
                dy = int(np.clip(round(shift_y / max(magnitude, 1.0)), -1, 1))
                motion_amount = min(0.075, 0.018 + magnitude * 0.006) * float(motion.get("confidence", 0.0))
                riven_applied = True
        source = np.ascontiguousarray(frame_u16.astype(np.float32).reshape(-1) / UINT16_MAX)
        values = np.array([
            sharp, denoise, noise_floor, micro, saturation, warmth, budget,
            1.0 if riven_applied else 0.0, dx, dy, motion_amount,
        ], dtype=np.float32)
        dims = np.array([width, height], dtype=np.uint32)
        usage = self.wgpu.BufferUsage
        input_buffer = self._upload("niv99-input", source, usage.STORAGE, "CamX NIV99 input")
        output_buffer = self._empty(
            "niv99-output", source.nbytes, usage.STORAGE | usage.COPY_SRC, "CamX NIV99 output"
        )
        params_buffer = self._upload("niv99-parameters", values, usage.STORAGE, "CamX NIV99 parameters")
        dims_buffer = self._upload("frame-dimensions", dims, usage.STORAGE, "CamX frame dimensions")
        if delivery_mode == "NONE":
            self._dispatch(self._pipeline("NIV99", NIV99_SHADER),
                           [input_buffer, output_buffer, params_buffer, dims_buffer], width, height)
            final_buffer = output_buffer
        else:
            if delivery_parameters is None or delivery_mode not in delivery_parameters:
                raise ValueError(f"Unknown canonical delivery mode {delivery_mode}")
            config = delivery_parameters[delivery_mode]
            delivery_values = np.array([
                config["gamma"], config["toe_width"], config["toe_amount"], config["desat"],
                config["shadow_lift"], config["contrast"], config["chroma_boost"], config["sky_bonus"],
                diffuse_reference, warm_skin_red_tame, config["peak_nits"],
            ], dtype=np.float32)
            quantized_buffer = self._empty(
                "continuum-niv99-rgb48", source.nbytes, usage.STORAGE,
                "NIVUKX Continuum NIV99 RGB48 boundary",
            )
            delivery_params_buffer = self._upload(
                "continuum-delivery-parameters", delivery_values, usage.STORAGE,
                "NIVUKX Continuum delivery parameters",
            )
            delivery_buffer = self._empty(
                "continuum-delivery-output", source.nbytes, usage.STORAGE | usage.COPY_SRC,
                "NIVUKX Continuum delivery output",
            )
            encoder = self.device.create_command_encoder(label="NIVUKX Continuum NIV99 delivery graph")
            dispatch = ((width + 15) // 16, (height + 15) // 16, 1)
            self._encode_dispatch(
                encoder, self._pipeline("NIV99", NIV99_SHADER),
                [input_buffer, output_buffer, params_buffer, dims_buffer], dispatch, "Continuum NIV99",
            )
            self._quantize_dispatch(encoder, output_buffer, quantized_buffer, dims_buffer, width, height)
            self._encode_dispatch(
                encoder, self._pipeline("canonical delivery", DELIVERY_SHADER),
                [quantized_buffer, delivery_buffer, delivery_params_buffer, dims_buffer],
                dispatch, "Continuum canonical delivery",
            )
            self._submit(encoder)
            final_buffer = delivery_buffer
        result = np.frombuffer(self._read(final_buffer), dtype=np.float32).copy()
        return self._quantize(result, frame_u16.shape), riven_applied

    def cache_mfsr_frame(self, frame_u16: np.ndarray) -> int:
        """Upload one temporal source exactly once into an eight-frame device ring."""
        shape = tuple(int(value) for value in frame_u16.shape)
        if self._mfsr_shape != shape:
            self._mfsr_shape = shape
            self._mfsr_sequence = 0
            self._mfsr_tokens = [None] * len(self._mfsr_tokens)
        token = self._mfsr_sequence
        self._mfsr_sequence += 1
        slot = token % len(self._mfsr_tokens)
        source = self._pack_rgb48(frame_u16)
        self._upload(
            f"mfsr-ring-{slot}", source, self.wgpu.BufferUsage.STORAGE,
            f"NIVUKX MFSR temporal frame {slot}",
        )
        self._mfsr_tokens[slot] = token
        return token

    def _mfsr_frame_buffer(self, token: int):
        slot = int(token) % len(self._mfsr_tokens)
        if self._mfsr_tokens[slot] != token:
            raise GpuComputeUnavailable("MFSR temporal frame was evicted before its ordered submission")
        return self._buffers[f"mfsr-ring-{slot}"][2]

    def estimate_motion_fields(
        self,
        reference: np.ndarray,
        candidates: list[tuple[np.ndarray, float, float]],
        columns: int = 6,
        rows: int = 4,
        search_radius: int = 2,
    ) -> list[tuple[np.ndarray, np.ndarray, np.ndarray]]:
        """Batch the camera-equivalent local block search for every history frame."""
        if not candidates:
            return []
        height, width = reference.shape
        columns = max(1, min(int(columns), width // 12))
        rows = max(1, min(int(rows), height // 12))
        for candidate, _shift_x, _shift_y in candidates:
            if candidate.shape != reference.shape:
                raise ValueError("MFSR motion proxies must share one geometry")
        reference_values = np.ascontiguousarray(reference.astype(np.float32).reshape(-1))
        candidate_values = np.ascontiguousarray(np.stack([
            item[0].astype(np.float32, copy=False) for item in candidates
        ]).reshape(-1))
        params = [width, height, columns, rows, max(0, int(search_radius)), len(candidates)]
        for _candidate, shift_x, shift_y in candidates:
            params.extend([int(round(shift_x)), int(round(shift_y))])
        param_values = np.asarray(params, dtype=np.int32)
        output_count = len(candidates) * columns * rows * 3
        usage = self.wgpu.BufferUsage
        reference_buffer = self._upload(
            "motion-reference", reference_values, usage.STORAGE, "NIVUKX motion reference"
        )
        candidates_buffer = self._upload(
            "motion-candidates", candidate_values, usage.STORAGE, "NIVUKX motion candidates"
        )
        params_buffer = self._upload(
            "motion-parameters", param_values, usage.STORAGE, "NIVUKX motion parameters"
        )
        raw_buffer = self._empty(
            "motion-fields-raw", output_count * 4, usage.STORAGE, "NIVUKX raw motion fields"
        )
        output_buffer = self._empty(
            "motion-fields-final", output_count * 4, usage.STORAGE | usage.COPY_SRC,
            "NIVUKX smoothed motion fields",
        )
        encoder = self.device.create_command_encoder(label="NIVUKX Continuum motion graph")
        dispatch = (columns, rows, len(candidates))
        self._encode_dispatch(
            encoder, self._pipeline("MFSR motion search", MFSR_MOTION_SEARCH_SHADER),
            [reference_buffer, candidates_buffer, raw_buffer, params_buffer], dispatch,
            "MFSR motion search",
        )
        self._encode_dispatch(
            encoder, self._pipeline("MFSR motion smooth", MFSR_MOTION_SMOOTH_SHADER),
            [raw_buffer, output_buffer, params_buffer], dispatch, "MFSR motion smoothing",
        )
        self._submit(encoder)
        values = np.frombuffer(self._read(output_buffer), dtype=np.float32).copy()
        fields = []
        grid_size = columns * rows
        candidate_stride = grid_size * 3
        for index in range(len(candidates)):
            base = index * candidate_stride
            fields.append((
                values[base:base + grid_size].reshape(rows, columns),
                values[base + grid_size:base + grid_size * 2].reshape(rows, columns),
                values[base + grid_size * 2:base + grid_size * 3].reshape(rows, columns),
            ))
        return fields

    def mfsr(self, frame_u16: np.ndarray, candidates: list, strength: float,
             noise_s: float, noise_o: float, current_token: int | None = None,
             reference_proxy: np.ndarray | None = None,
             proxy_motion: list[tuple[np.ndarray, float, float]] | None = None,
             field_scale: tuple[float, float] = (1.0, 1.0)) -> tuple[np.ndarray, float]:
        height, width = frame_u16.shape[:2]
        pixel_count = width * height
        dims = np.array([width, height], dtype=np.uint32)
        usage = self.wgpu.BufferUsage
        if current_token is None:
            current_token = self.cache_mfsr_frame(frame_u16)
        current_buffer = self._mfsr_frame_buffer(current_token)
        float_bytes = frame_u16.size * np.dtype(np.float32).itemsize
        accumulation_buffer = self._empty(
            "mfsr-accumulation", float_bytes, usage.STORAGE, "NIVUKX MFSR accumulation"
        )
        weights_buffer = self._empty(
            "mfsr-weights", pixel_count * 4, usage.STORAGE, "NIVUKX MFSR weights"
        )
        accepted_buffer = self._empty(
            "mfsr-accepted", pixel_count * 4, usage.STORAGE, "NIVUKX MFSR accepted"
        )
        output_buffer = self._empty(
            "mfsr-output", float_bytes, usage.STORAGE | usage.COPY_SRC, "NIVUKX MFSR output"
        )
        totals_buffer = self._upload(
            "mfsr-totals", np.zeros(1, dtype=np.uint32), usage.STORAGE | usage.COPY_SRC,
            "NIVUKX MFSR consensus total",
            force=True,
        )
        dims_buffer = self._upload("frame-dimensions", dims, usage.STORAGE, "CamX frame dimensions")
        final_params = self._upload(
            "mfsr-final-parameters", np.array([strength, len(candidates)], dtype=np.float32),
            usage.STORAGE, "NIVUKX MFSR final parameters",
        )

        motion_resources = None
        if (reference_proxy is not None and proxy_motion is not None and
                len(proxy_motion) == len(candidates) and len(candidates) > 0):
            proxy_height, proxy_width = reference_proxy.shape
            columns = max(1, min(6, proxy_width // 12))
            rows = max(1, min(4, proxy_height // 12))
            reference_values = np.ascontiguousarray(reference_proxy.astype(np.float32).reshape(-1))
            candidate_values = np.ascontiguousarray(np.stack([
                item[0].astype(np.float32, copy=False) for item in proxy_motion
            ]).reshape(-1))
            motion_params = [proxy_width, proxy_height, columns, rows, 2, len(proxy_motion)]
            for _candidate_proxy, shift_x, shift_y in proxy_motion:
                motion_params.extend([int(round(shift_x)), int(round(shift_y))])
            motion_params_values = np.asarray(motion_params, dtype=np.int32)
            motion_count = len(proxy_motion) * columns * rows * 3
            motion_resources = {
                "reference": self._upload(
                    "mfsr-motion-reference", reference_values, usage.STORAGE,
                    "NIVUKX resident motion reference",
                ),
                "candidates": self._upload(
                    "mfsr-motion-candidates", candidate_values, usage.STORAGE,
                    "NIVUKX resident motion candidates",
                ),
                "parameters": self._upload(
                    "mfsr-motion-parameters", motion_params_values, usage.STORAGE,
                    "NIVUKX resident motion parameters",
                ),
                "raw": self._empty(
                    "mfsr-motion-raw", motion_count * 4, usage.STORAGE,
                    "NIVUKX resident raw motion fields",
                ),
                "fields": self._empty(
                    "mfsr-motion-fields", motion_count * 4, usage.STORAGE,
                    "NIVUKX resident smoothed motion fields",
                ),
                "columns": columns,
                "rows": rows,
            }

        encoder = self.device.create_command_encoder(label="NIVUKX Continuum MFSR frame graph")
        dispatch = ((width + 15) // 16, (height + 15) // 16, 1)
        if motion_resources is not None:
            motion_dispatch = (motion_resources["columns"], motion_resources["rows"], len(candidates))
            self._encode_dispatch(
                encoder, self._pipeline("MFSR motion search", MFSR_MOTION_SEARCH_SHADER),
                [motion_resources["reference"], motion_resources["candidates"],
                 motion_resources["raw"], motion_resources["parameters"]],
                motion_dispatch, "MFSR resident motion search",
            )
            self._encode_dispatch(
                encoder, self._pipeline("MFSR motion smooth", MFSR_MOTION_SMOOTH_SHADER),
                [motion_resources["raw"], motion_resources["fields"], motion_resources["parameters"]],
                motion_dispatch, "MFSR resident motion smoothing",
            )
        self._encode_dispatch(
            encoder, self._pipeline("MFSR initialize", MFSR_INITIALIZE_SHADER),
            [current_buffer, accumulation_buffer, weights_buffer, accepted_buffer, dims_buffer],
            dispatch, "MFSR initialize",
        )
        accumulation_pipeline = self._pipeline("MFSR accumulation", MFSR_ACCUMULATE_SHADER)
        for index, (previous, _shift_x, _shift_y, confidence, _disagreement, motion_field) in enumerate(candidates):
            if motion_resources is not None:
                field_buffer = motion_resources["fields"]
                field_columns = motion_resources["columns"]
                field_rows = motion_resources["rows"]
                field_index = index
                scale_x, scale_y = field_scale
            else:
                if motion_field is None:
                    raise ValueError("MFSR requires a motion field when no resident registration graph is supplied")
                field_x, field_y, field_confidence = motion_field
                field_values = np.ascontiguousarray(np.concatenate([
                    field_x.astype(np.float32).reshape(-1), field_y.astype(np.float32).reshape(-1),
                    field_confidence.astype(np.float32).reshape(-1),
                ]))
                field_buffer = self._upload(
                    f"mfsr-field-{index}", field_values, usage.STORAGE,
                    f"NIVUKX MFSR motion field {index}",
                )
                field_columns = field_x.shape[1]
                field_rows = field_x.shape[0]
                field_index = 0
                scale_x = scale_y = 1.0
            values = np.array([
                strength, confidence, noise_s, noise_o, field_columns, field_rows,
                field_index, scale_x, scale_y,
            ], dtype=np.float32)
            token = getattr(previous, "gpu_token", None)
            if token is None:
                candidate_values = np.ascontiguousarray(
                    previous.pixels.astype(np.float32).reshape(-1) / UINT16_MAX
                )
                candidate_buffer = self._upload(
                    f"mfsr-uncached-candidate-{index}", candidate_values, usage.STORAGE,
                    f"NIVUKX MFSR uncached candidate {index}",
                )
            else:
                candidate_buffer = self._mfsr_frame_buffer(token)
            params_buffer = self._upload(
                f"mfsr-parameters-{index}", values, usage.STORAGE,
                f"NIVUKX MFSR parameters {index}",
            )
            self._encode_dispatch(encoder, accumulation_pipeline, [
                current_buffer, candidate_buffer, accumulation_buffer, weights_buffer,
                accepted_buffer, field_buffer, params_buffer, dims_buffer,
            ], dispatch, f"MFSR candidate {index}")

        self._encode_dispatch(encoder, self._pipeline("MFSR finalize", MFSR_FINALIZE_SHADER), [
            current_buffer, accumulation_buffer, weights_buffer, accepted_buffer,
            output_buffer, final_params, dims_buffer, totals_buffer,
        ], dispatch, "MFSR finalize")
        self._submit(encoder)
        accepted_total = int(np.frombuffer(self._read(totals_buffer, 4), dtype=np.uint32)[0])
        consensus = accepted_total / max(1.0, float(pixel_count * len(candidates)))
        self._last_mfsr_graph = {
            "version": CONTINUUM_VERSION,
            "candidateDispatches": len(candidates),
            "submissions": 1,
            "fullFrameReadbacks": 1,
            "statisticsReadbackBytes": 4,
            "historyFramesReused": sum(getattr(item[0], "gpu_token", None) is not None for item in candidates),
            "motionRegistrationResident": motion_resources is not None,
        }
        return self._read_quantized_rgb48(output_buffer, frame_u16.shape), float(consensus)

    def apply_ai_guidance(self, frame_u16: np.ndarray, curves: np.ndarray,
                          denoise_mix: float, detail_mix: float, temporal_mix: float,
                          previous_u16: np.ndarray | None) -> np.ndarray:
        height, width = frame_u16.shape[:2]
        source = np.ascontiguousarray(frame_u16.astype(np.float32).reshape(-1) / UINT16_MAX)
        if previous_u16 is None:
            previous_values = source
        else:
            previous_values = np.ascontiguousarray(previous_u16.astype(np.float32).reshape(-1) / UINT16_MAX)
        curve_values = np.ascontiguousarray(curves.astype(np.float32).reshape(-1))
        values = np.array([
            denoise_mix, detail_mix, min(0.18, temporal_mix), 0.0 if previous_u16 is None else 1.0,
        ], dtype=np.float32)
        dims = np.array([width, height], dtype=np.uint32)
        usage = self.wgpu.BufferUsage
        source_buffer = self._upload("ai-source", source, usage.STORAGE, "CamX AI source")
        previous_buffer = self._upload("ai-previous", previous_values, usage.STORAGE, "CamX AI previous")
        curves_buffer = self._upload("ai-curves", curve_values, usage.STORAGE, "CamX AI curves")
        output_buffer = self._empty(
            "ai-output", source.nbytes, usage.STORAGE | usage.COPY_SRC, "CamX AI output"
        )
        params_buffer = self._upload("ai-parameters", values, usage.STORAGE, "CamX AI parameters")
        dims_buffer = self._upload("frame-dimensions", dims, usage.STORAGE, "CamX frame dimensions")
        self._dispatch(self._pipeline("AI guidance", AI_GUIDANCE_SHADER), [
            source_buffer, previous_buffer, curves_buffer, output_buffer, params_buffer, dims_buffer,
        ], width, height)
        result = np.frombuffer(self._read(output_buffer), dtype=np.float32).copy()
        return self._quantize(result, frame_u16.shape)

    def apply_ai_guidance_resident(
        self,
        frame_u16: np.ndarray,
        curves: np.ndarray,
        denoise_mix: float,
        detail_mix: float,
        temporal_mix: float,
        *,
        reset_temporal: bool = False,
        delivery_mode: str = "NONE",
        diffuse_reference: float = 0.18,
        warm_skin_red_tame: float = 0.50,
        delivery_parameters: dict[str, dict] | None = None,
        destination: np.ndarray | None = None,
        delivery_destination: np.ndarray | None = None,
    ) -> tuple[np.ndarray, dict]:
        """Run AI guidance and optional proprietary delivery as one GPU frame graph.

        The quantize node preserves the historical RGB48 boundary between kernels.
        The previous AI result stays on the device, eliminating a full-frame upload
        on the next frame.  Only the final externally visible frame is downloaded.
        """
        if frame_u16.size * np.dtype(np.float32).itemsize > MAX_SINGLE_PASS_FLOAT_BYTES:
            shape = tuple(int(value) for value in frame_u16.shape)
            if self._continuum_previous_shape != shape:
                self._continuum_previous_shape = shape
                self._tiled_ai_previous = None
            if reset_temporal:
                self._tiled_ai_previous = None
            previous = self._tiled_ai_previous
            guided = self._rgb48_destination(frame_u16, destination)
            if previous is not None and np.shares_memory(guided, previous):
                guided = np.empty_like(frame_u16)
            tile_count = 0
            for start in range(0, frame_u16.shape[0], FULL_WIDTH_TILE_ROWS):
                end = min(frame_u16.shape[0], start + FULL_WIDTH_TILE_ROWS)
                source_strip = self._padded_rows(frame_u16, start, end, 1)
                previous_strip = self._padded_rows(previous, start, end, 1) if previous is not None else None
                result = self.apply_ai_guidance(
                    source_strip, curves, denoise_mix, detail_mix, temporal_mix, previous_strip
                )
                guided[start:end] = result[1:1 + end - start]
                tile_count += 1
            self._tiled_ai_previous = guided
            # Do not retain the prior full-resolution host frame while the
            # delivery pass allocates its output.  The new temporal frame is
            # already retained above.
            previous = None
            if delivery_mode == "NONE":
                delivered = guided
            else:
                if delivery_parameters is None or delivery_mode not in delivery_parameters:
                    raise ValueError(f"Unknown canonical delivery mode {delivery_mode}")
                delivered = self.canonical_delivery(
                    guided, delivery_mode, diffuse_reference,
                    warm_skin_red_tame, delivery_parameters,
                    destination=delivery_destination,
                )
            return delivered, {
                "version": CONTINUUM_VERSION,
                "stages": ["AI guidance", "RGB48 exact boundary"] +
                    (["NDR/NIVUKX delivery"] if delivery_mode != "NONE" else []),
                "submissions": tile_count * (2 if delivery_mode != "NONE" else 1),
                "fullFrameReadbacks": 0,
                "tileReadbacks": tile_count * (2 if delivery_mode != "NONE" else 1),
                "tileRows": FULL_WIDTH_TILE_ROWS,
                "memoryBounded": True,
                "residentTemporalState": True,
            }

        height, width = frame_u16.shape[:2]
        shape = tuple(int(value) for value in frame_u16.shape)
        if self._continuum_previous_shape != shape:
            self._continuum_previous_shape = shape
            self._continuum_previous_valid = False
        source = np.ascontiguousarray(frame_u16.astype(np.float32).reshape(-1) / UINT16_MAX)
        curve_values = np.ascontiguousarray(curves.astype(np.float32).reshape(-1))
        has_previous = self._continuum_previous_valid and not reset_temporal
        ai_values = np.array([
            denoise_mix, detail_mix, min(0.18, temporal_mix), 1.0 if has_previous else 0.0,
        ], dtype=np.float32)
        dims = np.array([width, height], dtype=np.uint32)
        usage = self.wgpu.BufferUsage
        source_buffer = self._upload(
            "continuum-source", source, usage.STORAGE, "NIVUKX Continuum source"
        )
        previous_buffer = self._empty(
            "continuum-ai-previous", source.nbytes, usage.STORAGE | usage.COPY_DST,
            "NIVUKX Continuum temporal state",
        )
        curves_buffer = self._upload(
            "continuum-ai-curves", curve_values, usage.STORAGE, "NIVUKX Continuum AI curves"
        )
        ai_params_buffer = self._upload(
            "continuum-ai-parameters", ai_values, usage.STORAGE, "NIVUKX Continuum AI parameters"
        )
        dims_buffer = self._upload("frame-dimensions", dims, usage.STORAGE, "CamX frame dimensions")
        ai_float_buffer = self._empty(
            "continuum-ai-float", source.nbytes, usage.STORAGE, "NIVUKX Continuum AI float output"
        )
        quantized_buffer = self._empty(
            "continuum-ai-rgb48", source.nbytes, usage.STORAGE | usage.COPY_SRC,
            "NIVUKX Continuum AI RGB48 boundary",
        )

        encoder = self.device.create_command_encoder(label="NIVUKX Continuum resident frame graph")
        dispatch = ((width + 15) // 16, (height + 15) // 16, 1)
        self._encode_dispatch(
            encoder, self._pipeline("AI guidance", AI_GUIDANCE_SHADER),
            [source_buffer, previous_buffer if has_previous else source_buffer, curves_buffer,
             ai_float_buffer, ai_params_buffer, dims_buffer],
            dispatch, "Continuum AI guidance",
        )
        self._quantize_dispatch(encoder, ai_float_buffer, quantized_buffer, dims_buffer, width, height)
        encoder.copy_buffer_to_buffer(quantized_buffer, 0, previous_buffer, 0, source.nbytes)

        final_buffer = quantized_buffer
        stages = ["AI guidance", "RGB48 exact boundary"]
        if delivery_mode != "NONE":
            if delivery_parameters is None or delivery_mode not in delivery_parameters:
                raise ValueError(f"Unknown canonical delivery mode {delivery_mode}")
            config = delivery_parameters[delivery_mode]
            delivery_values = np.array([
                config["gamma"], config["toe_width"], config["toe_amount"], config["desat"],
                config["shadow_lift"], config["contrast"], config["chroma_boost"], config["sky_bonus"],
                diffuse_reference, warm_skin_red_tame, config["peak_nits"],
            ], dtype=np.float32)
            delivery_params_buffer = self._upload(
                "continuum-delivery-parameters", delivery_values, usage.STORAGE,
                "NIVUKX Continuum delivery parameters",
            )
            delivery_buffer = self._empty(
                "continuum-delivery-output", source.nbytes, usage.STORAGE | usage.COPY_SRC,
                "NIVUKX Continuum delivery output",
            )
            self._encode_dispatch(
                encoder, self._pipeline("canonical delivery", DELIVERY_SHADER),
                [quantized_buffer, delivery_buffer, delivery_params_buffer, dims_buffer],
                dispatch, "Continuum canonical delivery",
            )
            final_buffer = delivery_buffer
            stages.append("NDR/NIVUKX delivery")

        try:
            self._submit(encoder)
            result = np.frombuffer(self._read(final_buffer), dtype=np.float32).copy()
            self._continuum_previous_valid = True
        except Exception:
            self._continuum_previous_valid = False
            raise
        developed = self._quantize(result, frame_u16.shape)
        if destination is not None and not np.shares_memory(destination, frame_u16):
            output = self._rgb48_destination(frame_u16, destination)
            output[...] = developed
            developed = output
        return developed, {
            "version": CONTINUUM_VERSION,
            "stages": stages,
            "submissions": 1,
            "fullFrameReadbacks": 1,
            "residentTemporalState": True,
        }
