/**
 * DXGI Desktop Duplication capture addon for Node.js (N-API).
 *
 * This is a placeholder. The full implementation will use the
 * IDXGIOutputDuplication interface to capture frames from a display
 * and return them as BGRA buffers to the Node.js main process.
 *
 * Exported functions:
 *   - startCapture(sourceId: string): void
 *   - stopCapture(): void
 *   - getLatestFrame(): { buffer: Buffer, width: number, height: number } | null
 */

#include <napi.h>

Napi::Value StartCapture(const Napi::CallbackInfo& info) {
  // TODO: Initialize DXGI output duplication for the requested source.
  return info.Env().Undefined();
}

Napi::Value StopCapture(const Napi::CallbackInfo& info) {
  // TODO: Release DXGI resources.
  return info.Env().Undefined();
}

Napi::Value GetLatestFrame(const Napi::CallbackInfo& info) {
  // TODO: Acquire next frame, copy pixels into a Node Buffer, return object.
  return info.Env().Null();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("startCapture", Napi::Function::New(env, StartCapture));
  exports.Set("stopCapture", Napi::Function::New(env, StopCapture));
  exports.Set("getLatestFrame", Napi::Function::New(env, GetLatestFrame));
  return exports;
}

NODE_API_MODULE(dxgi_capture, Init)
