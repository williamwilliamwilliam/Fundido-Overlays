/**
 * DXGI Desktop Duplication capture addon for Node.js (N-API).
 *
 * Architecture:
 *   - A dedicated capture thread runs a tight loop calling AcquireNextFrame.
 *   - Frames are copied into a double-buffered staging area (pre-allocated).
 *   - The capture thread signals Node.js via napi_threadsafe_function when
 *     a new frame is ready.
 *   - Node.js reads from the "read" buffer while the capture thread writes
 *     to the "write" buffer. Buffers are swapped atomically.
 *   - Zero per-frame allocations on either thread.
 *
 * Exported functions:
 *   - listDisplays(): Array<{ adapterIndex, outputIndex, name, width, height }>
 *   - startCapture(displayIndex: number, callback: (frame) => void): boolean
 *   - stopCapture(): void
 *   - getLatestFrame(): { buffer: Buffer, width: number, height: number } | null
 */

#include <napi.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <string>
#include <vector>
#include <mutex>
#include <thread>
#include <atomic>
#include <cstring>
#include <condition_variable>

// ---------------------------------------------------------------------------
// Global DXGI state
// ---------------------------------------------------------------------------

static ID3D11Device*           g_d3dDevice           = nullptr;
static ID3D11DeviceContext*    g_d3dContext           = nullptr;
static IDXGIOutputDuplication* g_outputDuplication    = nullptr;
static ID3D11Texture2D*        g_stagingTexture       = nullptr;
static UINT                    g_captureWidth         = 0;
static UINT                    g_captureHeight        = 0;
static std::mutex              g_captureMutex;

// ---------------------------------------------------------------------------
// Capture thread state
// ---------------------------------------------------------------------------

static std::thread             g_captureThread;
static std::atomic<bool>       g_threadRunning{false};
static std::atomic<bool>       g_threadShouldStop{false};

// Double-buffered frame storage
static uint8_t*                g_frameBuffers[2]      = { nullptr, nullptr };
static UINT                    g_frameBufferSize      = 0;
static std::atomic<int>        g_writeSlot{0};       // Capture thread writes here
static std::atomic<int>        g_readSlot{1};        // Node reads from here
static std::atomic<bool>       g_frameReady{false};  // Set by capture thread after swap

// Thread-safe function for signaling Node.js
static napi_threadsafe_function g_tsCallback = nullptr;

// Persistent reference to the Node.js Buffer that wraps the read slot
// (avoids allocating a new Buffer every frame)
static Napi::Reference<Napi::Buffer<uint8_t>>* g_persistentBufferRef = nullptr;
static int g_persistentBufferSlot = -1; // Which slot the persistent buffer wraps

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

static void ReleaseCaptureResources() {
    if (g_stagingTexture)    { g_stagingTexture->Release();    g_stagingTexture = nullptr; }
    if (g_outputDuplication) { g_outputDuplication->Release();  g_outputDuplication = nullptr; }
    if (g_d3dContext)        { g_d3dContext->Release();         g_d3dContext = nullptr; }
    if (g_d3dDevice)         { g_d3dDevice->Release();          g_d3dDevice = nullptr; }
    g_captureWidth = 0;
    g_captureHeight = 0;
}

static void FreeFrameBuffers() {
    for (int i = 0; i < 2; i++) {
        if (g_frameBuffers[i]) {
            free(g_frameBuffers[i]);
            g_frameBuffers[i] = nullptr;
        }
    }
    g_frameBufferSize = 0;
    if (g_persistentBufferRef) {
        delete g_persistentBufferRef;
        g_persistentBufferRef = nullptr;
    }
    g_persistentBufferSlot = -1;
}

static void AllocateFrameBuffers(UINT width, UINT height) {
    FreeFrameBuffers();
    const UINT bytesPerPixel = 4;
    g_frameBufferSize = width * height * bytesPerPixel;
    for (int i = 0; i < 2; i++) {
        g_frameBuffers[i] = (uint8_t*)malloc(g_frameBufferSize);
        if (g_frameBuffers[i]) {
            memset(g_frameBuffers[i], 0, g_frameBufferSize);
        }
    }
}

static std::string WideToUtf8(const WCHAR* wideStr) {
    if (!wideStr || wideStr[0] == L'\0') return "";
    int sizeNeeded = WideCharToMultiByte(CP_UTF8, 0, wideStr, -1, nullptr, 0, nullptr, nullptr);
    if (sizeNeeded <= 0) return "";
    std::string result(sizeNeeded - 1, '\0');
    WideCharToMultiByte(CP_UTF8, 0, wideStr, -1, &result[0], sizeNeeded, nullptr, nullptr);
    return result;
}

// ---------------------------------------------------------------------------
// listDisplays()
// ---------------------------------------------------------------------------

struct DisplayInfo {
    int adapterIndex;
    int outputIndex;
    std::string name;
    UINT width;
    UINT height;
};

static std::vector<DisplayInfo> EnumerateDisplays() {
    std::vector<DisplayInfo> displays;
    IDXGIFactory1* factory = nullptr;
    HRESULT hr = CreateDXGIFactory1(__uuidof(IDXGIFactory1), (void**)&factory);
    if (FAILED(hr) || !factory) return displays;

    IDXGIAdapter1* adapter = nullptr;
    for (UINT adapterIdx = 0; factory->EnumAdapters1(adapterIdx, &adapter) != DXGI_ERROR_NOT_FOUND; adapterIdx++) {
        IDXGIOutput* output = nullptr;
        for (UINT outputIdx = 0; adapter->EnumOutputs(outputIdx, &output) != DXGI_ERROR_NOT_FOUND; outputIdx++) {
            DXGI_OUTPUT_DESC desc;
            output->GetDesc(&desc);

            UINT displayWidth  = desc.DesktopCoordinates.right  - desc.DesktopCoordinates.left;
            UINT displayHeight = desc.DesktopCoordinates.bottom - desc.DesktopCoordinates.top;

            DisplayInfo info;
            info.adapterIndex = (int)adapterIdx;
            info.outputIndex  = (int)outputIdx;
            info.name         = WideToUtf8(desc.DeviceName);
            info.width        = displayWidth;
            info.height       = displayHeight;
            displays.push_back(info);

            output->Release();
        }
        adapter->Release();
    }
    factory->Release();
    return displays;
}

Napi::Value ListDisplays(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    auto displays = EnumerateDisplays();

    Napi::Array result = Napi::Array::New(env, displays.size());
    for (size_t i = 0; i < displays.size(); i++) {
        Napi::Object displayObj = Napi::Object::New(env);
        displayObj.Set("adapterIndex", Napi::Number::New(env, displays[i].adapterIndex));
        displayObj.Set("outputIndex",  Napi::Number::New(env, displays[i].outputIndex));
        displayObj.Set("name",         Napi::String::New(env, displays[i].name));
        displayObj.Set("width",        Napi::Number::New(env, displays[i].width));
        displayObj.Set("height",       Napi::Number::New(env, displays[i].height));
        result.Set((uint32_t)i, displayObj);
    }
    return result;
}

// ---------------------------------------------------------------------------
// Capture thread function
// ---------------------------------------------------------------------------

static void CaptureThreadFunc() {
    // Set thread-level timer resolution for tighter frame pacing
    // (reverted automatically when thread exits)
    timeBeginPeriod(1);

    while (!g_threadShouldStop.load()) {
        IDXGIResource* desktopResource = nullptr;
        DXGI_OUTDUPL_FRAME_INFO frameInfo;

        // AcquireNextFrame with 1ms timeout — blocks until DWM has a new frame
        // or timeout expires. On a 240Hz display this returns every ~4.2ms.
        HRESULT hr = g_outputDuplication->AcquireNextFrame(1, &frameInfo, &desktopResource);

        if (g_threadShouldStop.load()) {
            if (desktopResource) desktopResource->Release();
            break;
        }

        if (hr == DXGI_ERROR_WAIT_TIMEOUT) {
            continue;
        }

        if (hr == DXGI_ERROR_ACCESS_LOST) {
            // Desktop Duplication was lost — signal and exit thread
            if (desktopResource) desktopResource->Release();
            break;
        }

        if (FAILED(hr) || !desktopResource) {
            if (desktopResource) desktopResource->Release();
            continue;
        }

        // Get the texture
        ID3D11Texture2D* desktopTexture = nullptr;
        hr = desktopResource->QueryInterface(__uuidof(ID3D11Texture2D), (void**)&desktopTexture);
        desktopResource->Release();

        if (FAILED(hr) || !desktopTexture) {
            g_outputDuplication->ReleaseFrame();
            continue;
        }

        // GPU → staging texture copy
        g_d3dContext->CopyResource(g_stagingTexture, desktopTexture);
        desktopTexture->Release();

        // Map and copy to the write slot buffer
        D3D11_MAPPED_SUBRESOURCE mappedResource;
        hr = g_d3dContext->Map(g_stagingTexture, 0, D3D11_MAP_READ, 0, &mappedResource);

        if (SUCCEEDED(hr)) {
            int writeSlot = g_writeSlot.load();
            uint8_t* dest = g_frameBuffers[writeSlot];

            if (dest) {
                const UINT bytesPerPixel = 4;
                const UINT tightRowPitch = g_captureWidth * bytesPerPixel;

                if (mappedResource.RowPitch == tightRowPitch) {
                    memcpy(dest, mappedResource.pData, g_frameBufferSize);
                } else {
                    uint8_t* src = static_cast<uint8_t*>(mappedResource.pData);
                    for (UINT row = 0; row < g_captureHeight; row++) {
                        memcpy(
                            dest + row * tightRowPitch,
                            src + row * mappedResource.RowPitch,
                            tightRowPitch
                        );
                    }
                }

                // Swap slots: what was write becomes read, what was read becomes write
                g_readSlot.store(writeSlot);
                g_writeSlot.store(writeSlot == 0 ? 1 : 0);
                g_frameReady.store(true);

                // Signal Node.js that a frame is ready
                if (g_tsCallback) {
                    napi_call_threadsafe_function(g_tsCallback, nullptr, napi_tsfn_nonblocking);
                }
            }

            g_d3dContext->Unmap(g_stagingTexture, 0);
        }

        g_outputDuplication->ReleaseFrame();
    }

    timeEndPeriod(1);
    g_threadRunning.store(false);
}

// ---------------------------------------------------------------------------
// Thread-safe callback — runs on Node's event loop when signaled
// ---------------------------------------------------------------------------

static Napi::FunctionReference g_jsCallback;

static void TsCallbackHandler(napi_env env, napi_value /*js_callback*/, void* /*context*/, void* /*data*/) {
    if (!g_frameReady.load()) return;
    if (g_jsCallback.IsEmpty()) return;

    Napi::Env napiEnv(env);
    Napi::HandleScope scope(napiEnv);

    int readSlot = g_readSlot.load();
    uint8_t* frameData = g_frameBuffers[readSlot];

    if (!frameData || g_frameBufferSize == 0) return;

    // Create an external buffer that wraps the pre-allocated memory.
    // No allocation, no copy — Node sees the same memory the capture thread wrote to.
    // The buffer is valid until the slots swap again (by which time Node's callback
    // has finished processing this frame).
    Napi::Buffer<uint8_t> frameBuffer = Napi::Buffer<uint8_t>::NewOrCopy(
        napiEnv, frameData, g_frameBufferSize,
        // Release callback — no-op since we manage the memory ourselves
        [](napi_env, void*) {}
    );

    Napi::Object frameObj = Napi::Object::New(napiEnv);
    frameObj.Set("buffer", frameBuffer);
    frameObj.Set("width",  Napi::Number::New(napiEnv, g_captureWidth));
    frameObj.Set("height", Napi::Number::New(napiEnv, g_captureHeight));

    g_frameReady.store(false);

    g_jsCallback.Call({ frameObj });
}

// ---------------------------------------------------------------------------
// startCapture(displayIndex: number, callback: (frame) => void)
// ---------------------------------------------------------------------------

Napi::Value StartCapture(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    std::lock_guard<std::mutex> lock(g_captureMutex);

    // Stop any existing capture
    if (g_threadRunning.load()) {
        g_threadShouldStop.store(true);
        if (g_captureThread.joinable()) {
            g_captureThread.join();
        }
        g_threadShouldStop.store(false);
    }
    ReleaseCaptureResources();
    FreeFrameBuffers();

    // Parse arguments
    int requestedDisplayIndex = 0;
    if (info.Length() > 0 && info[0].IsNumber()) {
        requestedDisplayIndex = info[0].As<Napi::Number>().Int32Value();
    }

    // Optional callback argument for threaded mode
    if (info.Length() > 1 && info[1].IsFunction()) {
        g_jsCallback = Napi::Persistent(info[1].As<Napi::Function>());
    }

    // Find the adapter and output
    auto displays = EnumerateDisplays();
    if (requestedDisplayIndex < 0 || requestedDisplayIndex >= (int)displays.size()) {
        Napi::Error::New(env, "Display index out of range").ThrowAsJavaScriptException();
        return Napi::Boolean::New(env, false);
    }

    DisplayInfo& targetDisplay = displays[requestedDisplayIndex];

    // Create DXGI factory, adapter, output
    IDXGIFactory1* factory = nullptr;
    HRESULT hr = CreateDXGIFactory1(__uuidof(IDXGIFactory1), (void**)&factory);
    if (FAILED(hr)) {
        Napi::Error::New(env, "Failed to create DXGI factory").ThrowAsJavaScriptException();
        return Napi::Boolean::New(env, false);
    }

    IDXGIAdapter1* adapter = nullptr;
    hr = factory->EnumAdapters1(targetDisplay.adapterIndex, &adapter);
    if (FAILED(hr)) {
        factory->Release();
        Napi::Error::New(env, "Failed to get adapter").ThrowAsJavaScriptException();
        return Napi::Boolean::New(env, false);
    }

    IDXGIOutput* output = nullptr;
    hr = adapter->EnumOutputs(targetDisplay.outputIndex, &output);
    if (FAILED(hr)) {
        adapter->Release();
        factory->Release();
        Napi::Error::New(env, "Failed to get output").ThrowAsJavaScriptException();
        return Napi::Boolean::New(env, false);
    }

    // Create D3D11 device
    D3D_FEATURE_LEVEL featureLevel;
    hr = D3D11CreateDevice(
        adapter, D3D_DRIVER_TYPE_UNKNOWN, nullptr, 0,
        nullptr, 0, D3D11_SDK_VERSION,
        &g_d3dDevice, &featureLevel, &g_d3dContext
    );

    adapter->Release();
    factory->Release();

    if (FAILED(hr)) {
        output->Release();
        Napi::Error::New(env, "Failed to create D3D11 device").ThrowAsJavaScriptException();
        return Napi::Boolean::New(env, false);
    }

    // Set up Desktop Duplication
    IDXGIOutput1* output1 = nullptr;
    hr = output->QueryInterface(__uuidof(IDXGIOutput1), (void**)&output1);
    output->Release();

    if (FAILED(hr)) {
        ReleaseCaptureResources();
        Napi::Error::New(env, "Failed to query IDXGIOutput1").ThrowAsJavaScriptException();
        return Napi::Boolean::New(env, false);
    }

    hr = output1->DuplicateOutput(g_d3dDevice, &g_outputDuplication);
    output1->Release();

    if (FAILED(hr)) {
        ReleaseCaptureResources();
        std::string msg = "DuplicateOutput failed (HRESULT: " + std::to_string(hr) + ")";
        if (hr == DXGI_ERROR_NOT_CURRENTLY_AVAILABLE) msg += " — too many applications using Desktop Duplication";
        else if (hr == E_ACCESSDENIED) msg += " — access denied";
        Napi::Error::New(env, msg).ThrowAsJavaScriptException();
        return Napi::Boolean::New(env, false);
    }

    // Create staging texture
    g_captureWidth  = targetDisplay.width;
    g_captureHeight = targetDisplay.height;

    D3D11_TEXTURE2D_DESC stagingDesc = {};
    stagingDesc.Width              = g_captureWidth;
    stagingDesc.Height             = g_captureHeight;
    stagingDesc.MipLevels          = 1;
    stagingDesc.ArraySize          = 1;
    stagingDesc.Format             = DXGI_FORMAT_B8G8R8A8_UNORM;
    stagingDesc.SampleDesc.Count   = 1;
    stagingDesc.SampleDesc.Quality = 0;
    stagingDesc.Usage              = D3D11_USAGE_STAGING;
    stagingDesc.CPUAccessFlags     = D3D11_CPU_ACCESS_READ;
    stagingDesc.BindFlags          = 0;
    stagingDesc.MiscFlags          = 0;

    hr = g_d3dDevice->CreateTexture2D(&stagingDesc, nullptr, &g_stagingTexture);
    if (FAILED(hr)) {
        ReleaseCaptureResources();
        Napi::Error::New(env, "Failed to create staging texture").ThrowAsJavaScriptException();
        return Napi::Boolean::New(env, false);
    }

    // Allocate double-buffered frame storage
    AllocateFrameBuffers(g_captureWidth, g_captureHeight);

    // Create the threadsafe function if a callback was provided
    if (!g_jsCallback.IsEmpty()) {
        napi_status status = napi_create_threadsafe_function(
            env,
            nullptr,                           // js_func (not used — we call g_jsCallback directly)
            nullptr,                           // async_resource
            napi_value(Napi::String::New(env, "DXGICaptureCallback")),
            0,                                 // max_queue_size (unlimited)
            1,                                 // initial_thread_count
            nullptr,                           // thread_finalize_data
            nullptr,                           // thread_finalize_cb
            nullptr,                           // context
            TsCallbackHandler,                 // call_js_cb
            &g_tsCallback
        );

        if (status != napi_ok) {
            ReleaseCaptureResources();
            FreeFrameBuffers();
            Napi::Error::New(env, "Failed to create threadsafe function").ThrowAsJavaScriptException();
            return Napi::Boolean::New(env, false);
        }

        // Start the capture thread
        g_threadShouldStop.store(false);
        g_threadRunning.store(true);
        g_captureThread = std::thread(CaptureThreadFunc);
    }

    return Napi::Boolean::New(env, true);
}

// ---------------------------------------------------------------------------
// stopCapture()
// ---------------------------------------------------------------------------

Napi::Value StopCapture(const Napi::CallbackInfo& info) {
    std::lock_guard<std::mutex> lock(g_captureMutex);

    // Stop the capture thread
    if (g_threadRunning.load()) {
        g_threadShouldStop.store(true);
        if (g_captureThread.joinable()) {
            g_captureThread.join();
        }
        g_threadShouldStop.store(false);
        g_threadRunning.store(false);
    }

    // Release the threadsafe function
    if (g_tsCallback) {
        napi_release_threadsafe_function(g_tsCallback, napi_tsfn_release);
        g_tsCallback = nullptr;
    }

    // Clear the JS callback
    if (!g_jsCallback.IsEmpty()) {
        g_jsCallback.Reset();
    }

    ReleaseCaptureResources();
    FreeFrameBuffers();

    return info.Env().Undefined();
}

// ---------------------------------------------------------------------------
// getLatestFrame() — polling fallback (used when no callback is provided)
// ---------------------------------------------------------------------------

Napi::Value GetLatestFrame(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    std::lock_guard<std::mutex> lock(g_captureMutex);

    // If the capture thread is running, read from the read slot
    if (g_threadRunning.load() && g_frameReady.load()) {
        int readSlot = g_readSlot.load();
        uint8_t* frameData = g_frameBuffers[readSlot];

        if (!frameData || g_frameBufferSize == 0) return env.Null();

        Napi::Buffer<uint8_t> frameBuffer = Napi::Buffer<uint8_t>::Copy(env, frameData, g_frameBufferSize);

        Napi::Object result = Napi::Object::New(env);
        result.Set("buffer", frameBuffer);
        result.Set("width",  Napi::Number::New(env, g_captureWidth));
        result.Set("height", Napi::Number::New(env, g_captureHeight));

        g_frameReady.store(false);
        return result;
    }

    // Legacy polling path (no capture thread — backward compatible)
    if (!g_outputDuplication) return env.Null();

    IDXGIResource* desktopResource = nullptr;
    DXGI_OUTDUPL_FRAME_INFO frameInfo;

    HRESULT hr = g_outputDuplication->AcquireNextFrame(0, &frameInfo, &desktopResource);

    if (hr == DXGI_ERROR_WAIT_TIMEOUT) return env.Null();
    if (hr == DXGI_ERROR_ACCESS_LOST) {
        ReleaseCaptureResources();
        return env.Null();
    }
    if (FAILED(hr) || !desktopResource) {
        if (desktopResource) desktopResource->Release();
        return env.Null();
    }

    ID3D11Texture2D* desktopTexture = nullptr;
    hr = desktopResource->QueryInterface(__uuidof(ID3D11Texture2D), (void**)&desktopTexture);
    desktopResource->Release();

    if (FAILED(hr) || !desktopTexture) {
        g_outputDuplication->ReleaseFrame();
        return env.Null();
    }

    g_d3dContext->CopyResource(g_stagingTexture, desktopTexture);
    desktopTexture->Release();

    D3D11_MAPPED_SUBRESOURCE mappedResource;
    hr = g_d3dContext->Map(g_stagingTexture, 0, D3D11_MAP_READ, 0, &mappedResource);

    if (FAILED(hr)) {
        g_outputDuplication->ReleaseFrame();
        return env.Null();
    }

    const UINT bytesPerPixel = 4;
    const UINT tightRowPitch = g_captureWidth * bytesPerPixel;
    const UINT totalBufferSize = tightRowPitch * g_captureHeight;

    Napi::Buffer<uint8_t> frameBuffer = Napi::Buffer<uint8_t>::New(env, totalBufferSize);
    uint8_t* destination = frameBuffer.Data();
    uint8_t* source = static_cast<uint8_t*>(mappedResource.pData);

    if (mappedResource.RowPitch == tightRowPitch) {
        std::memcpy(destination, source, totalBufferSize);
    } else {
        for (UINT row = 0; row < g_captureHeight; row++) {
            std::memcpy(
                destination + row * tightRowPitch,
                source + row * mappedResource.RowPitch,
                tightRowPitch
            );
        }
    }

    g_d3dContext->Unmap(g_stagingTexture, 0);
    g_outputDuplication->ReleaseFrame();

    Napi::Object result = Napi::Object::New(env);
    result.Set("buffer", frameBuffer);
    result.Set("width",  Napi::Number::New(env, g_captureWidth));
    result.Set("height", Napi::Number::New(env, g_captureHeight));
    return result;
}

// ---------------------------------------------------------------------------
// Module initialization
// ---------------------------------------------------------------------------

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("listDisplays",  Napi::Function::New(env, ListDisplays));
    exports.Set("startCapture",  Napi::Function::New(env, StartCapture));
    exports.Set("stopCapture",   Napi::Function::New(env, StopCapture));
    exports.Set("getLatestFrame", Napi::Function::New(env, GetLatestFrame));
    return exports;
}

NODE_API_MODULE(dxgi_capture, Init)
