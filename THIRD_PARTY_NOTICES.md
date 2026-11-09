# Third-party notices

CamX Studio bundles separate FFmpeg and FFprobe executables from the Gyan.dev FFmpeg full build. That build reports FFmpeg 9.0 with GPL/GPLv3 components enabled. Its license and upstream build information are installed under `resources/ffmpeg`.

The desktop shell uses Electron under the MIT license. Package-level license information is available in the project lockfile and dependency metadata.

CamX Studio bundles the Windows Android Debug Bridge executable and its Windows support libraries from Google's Android SDK Platform-Tools. They are used only for the user-authorized, read-only CamX phone bridge. Google's complete Platform-Tools notice is installed under `resources/android-platform-tools/NOTICE.txt`.

The CamX AI worker includes Python, Google LiteRT, NumPy, wgpu-py/wgpu-native and Microsoft ONNX Runtime DirectML plus supporting open-source packages. Their notices and license texts, including ONNX Runtime's third-party notices, are installed under `resources/ai/LICENSES`. The camera enhancement model is a project asset copied from the Android repository without modifying that repository. No Hugging Face or third-party super-resolution model is bundled.

CamX Studio launches FFmpeg and the AI worker as separate processes.
