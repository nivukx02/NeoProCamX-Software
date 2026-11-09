"""Export the bundled CamX LiteRT guidance network to a DirectML-ready ONNX graph.

The camera model is a fixed, fully-convolutional stack.  This exporter reads the
already-fused convolution weights from LiteRT instead of retraining or changing
the network.  A deterministic parity check is mandatory before the ONNX file is
published, so a bad conversion can never become a production runtime asset.
"""

from __future__ import annotations

import argparse
import os
import tempfile

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper
from ai_edge_litert.interpreter import Interpreter, OpResolverType


def _litert(model_path: str) -> Interpreter:
    runtime = Interpreter(
        model_path=model_path,
        experimental_op_resolver_type=OpResolverType.BUILTIN_WITHOUT_DEFAULT_DELEGATES,
    )
    input_index = runtime.get_input_details()[0]["index"]
    runtime.resize_tensor_input(input_index, [1, 256, 256, 3], strict=False)
    runtime.allocate_tensors()
    return runtime


def export_model(source_path: str, output_path: str) -> dict:
    runtime = _litert(source_path)
    operations = runtime._get_ops_details()  # LiteRT's stable diagnostic API.
    convolutions = [operation for operation in operations if operation["op_name"] == "CONV_2D"]
    if len(convolutions) != 17:
        raise RuntimeError(f"Expected the camera's 17 convolutions, found {len(convolutions)}")

    dequantized_sources = {
        int(operation["outputs"][0]): int(operation["inputs"][0])
        for operation in operations if operation["op_name"] == "DEQUANTIZE"
    }
    nodes = [helper.make_node("Transpose", ["input_nhwc"], ["feature_0"], perm=[0, 3, 1, 2])]
    initializers = []
    previous = "feature_0"
    for index, operation in enumerate(convolutions):
        _, weight_index, bias_index = [int(value) for value in operation["inputs"]]
        # TFLite stores Conv2D kernels as OHWI; ONNX consumes OIHW.
        weights = runtime.get_tensor(dequantized_sources.get(weight_index, weight_index)).astype(np.float32)
        bias = runtime.get_tensor(dequantized_sources.get(bias_index, bias_index)).astype(np.float32)
        weights = weights.transpose(0, 3, 1, 2).copy()
        bias = bias.reshape(-1).copy()
        weight_name = f"conv_{index}_weight"
        bias_name = f"conv_{index}_bias"
        convolution_output = f"conv_{index}_output"
        initializers.extend([
            numpy_helper.from_array(weights, weight_name),
            numpy_helper.from_array(bias, bias_name),
        ])
        nodes.append(helper.make_node(
            "Conv", [previous, weight_name, bias_name], [convolution_output],
            name=f"camera_conv_{index}", pads=[1, 1, 1, 1], strides=[1, 1], dilations=[1, 1],
        ))
        # Every camera Conv2D operator has fused_activation_function=RELU,
        # including the RGB projection layer.  Preserve that ordering exactly.
        activated = f"feature_{index + 1}"
        nodes.append(helper.make_node("Relu", [convolution_output], [activated], name=f"camera_relu_{index}"))
        previous = activated

    ceiling = np.array(1.0, dtype=np.float32)
    initializers.append(numpy_helper.from_array(ceiling, "output_ceiling"))
    nodes.extend([
        helper.make_node("Min", [previous, "output_ceiling"], ["clipped_high"], name="camera_clip_high"),
        helper.make_node("Relu", ["clipped_high"], ["output_nchw"], name="camera_clip_low"),
        helper.make_node("Transpose", ["output_nchw"], ["output_nhwc"], perm=[0, 2, 3, 1]),
    ])
    graph = helper.make_graph(
        nodes,
        "CamX Camera Enhancement Denoise",
        [helper.make_tensor_value_info("input_nhwc", TensorProto.FLOAT, [1, 256, 256, 3])],
        [helper.make_tensor_value_info("output_nhwc", TensorProto.FLOAT, [1, 256, 256, 3])],
        initializer=initializers,
    )
    model = helper.make_model(
        graph,
        producer_name="CamX Studio exact LiteRT-to-ONNX exporter",
        opset_imports=[helper.make_opsetid("", 18)],
    )
    model.ir_version = 11
    onnx.checker.check_model(model)

    import onnxruntime as ort

    rng = np.random.default_rng(0xCA9)
    sample = rng.random((1, 256, 256, 3), dtype=np.float32)
    input_index = runtime.get_input_details()[0]["index"]
    output_index = runtime.get_output_details()[0]["index"]
    runtime.set_tensor(input_index, sample)
    runtime.invoke()
    expected = runtime.get_tensor(output_index).copy()

    output_directory = os.path.dirname(os.path.abspath(output_path))
    os.makedirs(output_directory, exist_ok=True)
    descriptor, temporary_path = tempfile.mkstemp(prefix=".camx-ai-", suffix=".onnx", dir=output_directory)
    os.close(descriptor)
    try:
        onnx.save(model, temporary_path)
        session = ort.InferenceSession(temporary_path, providers=["CPUExecutionProvider"])
        actual = session.run(None, {"input_nhwc": sample})[0]
        maximum_error = float(np.max(np.abs(expected - actual)))
        mean_error = float(np.mean(np.abs(expected - actual)))
        if maximum_error > 2.0e-5 or mean_error > 2.0e-6:
            raise RuntimeError(
                f"ONNX parity failed (maximum={maximum_error:.9g}, mean={mean_error:.9g})"
            )
        os.replace(temporary_path, output_path)
    finally:
        if os.path.exists(temporary_path):
            os.unlink(temporary_path)
    return {
        "output": os.path.abspath(output_path),
        "convolutions": len(convolutions),
        "maximumError": maximum_error,
        "meanError": mean_error,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Export and verify the CamX DirectML graph")
    parser.add_argument("source")
    parser.add_argument("output")
    arguments = parser.parse_args()
    print(export_model(arguments.source, arguments.output))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
