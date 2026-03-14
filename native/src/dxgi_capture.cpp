/**
 * DXGI Desktop Duplication capture addon for Node.js (N-API).
 *
 * Uses the IDXGIOutputDuplication interface to capture frames from a
 * display and return them as BGRA pixel buffers to the Node.js main process.
 *
 * Exported functions:
 *   - listDisplays(): Array<{ adapterIndex, outputIndex, name, width, height }>
 *   - startCapture(displayIndex: number): boolean
 *   - stopCapture(): void
 *   - getLatestFrame(): { buffer: Buffer, width: number, height: number } | null
 */

#include <napi.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <string>
#include <vector>
#include <mutex>
#include <cstring>

// ---------------------------------------------------------------------------
// Global DXGI state
// ---------------------------------------------------------------------------

static ID3D11Device*           g_d3dDevice           = nullptr;
static ID3D11DeviceContext*    g_d3dContext           = nullptr;
static IDXGIOutputDuplication* g_outputDuplication    = nullptr;
static ID3D11Texture2D*        g_stagingTexture       = nullptr;
static bool                    g_isCapturing          = false;
static UINT                    g_captureWidth         = 0;
static UINT                    g_captureHeight        = 0;
static std::mutex              g_captureMutex;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

static void ReleaseCaptureResources() {
    if (g_stagingTexture)    { g_stagingTexture->Release();    g_stagingTexture = nullptr; }
    if (g_outputDuplication) { g_outputDuplication->Release();  g_outputDuplication = nullptr; }
    if (g_d3dContext)        { g_d3dContext->Release();         g_d3dContext = nullptr; }
    if (g_d3dDevice)         { g_d3dDevice->Release();          g_d3dDevice = nullptr; }
    g_isCapturing = false;
    g_captureWidth = 0;
    g_captureHeight = 0;
}

/**
 * Converts a wide string to a UTF-8 std::string.
 */
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
// startCapture(displayIndex: number)
// ---------------------------------------------------------------------------

Napi::Value StartCapture(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    std::lock_guard<std::mutex> lock(g_captureMutex);

    if (g_isCapturing) {
        ReleaseCaptureResources();
    }

    // Parse the display index argument (sequential index across all adapters/outputs)
    int requestedDisplayIndex = 0;
    if (info.Length() > 0 && info[0].IsNumber()) {
        requestedDisplayIndex = info[0].As<Napi::Number>().Int32Value();
    }

    // Find the adapter and output for the requested display index
    auto displays = EnumerateDisplays();
    if (requestedDisplayIndex < 0 || requestedDisplayIndex >= (int)displays.size()) {
        Napi::Error::New(env, "Display index out of range").ThrowAsJavaScriptException();
        return Napi::Boolean::New(env, false);
    }

    DisplayInfo& targetDisplay = displays[requestedDisplayIndex];

    // Enumerate to get the actual adapter and output COM objects
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

    // Create D3D11 device on this adapter
    D3D_FEATURE_LEVEL featureLevel;
    hr = D3D11CreateDevice(
        adapter,
        D3D_DRIVER_TYPE_UNKNOWN,
        nullptr,
        0,
        nullptr,
        0,
        D3D11_SDK_VERSION,
        &g_d3dDevice,
        &featureLevel,
        &g_d3dContext
    );

    adapter->Release();
    factory->Release();

    if (FAILED(hr)) {
        output->Release();
        Napi::Error::New(env, "Failed to create D3D11 device").ThrowAsJavaScriptException();
        return Napi::Boolean::New(env, false);
    }

    // Get IDXGIOutput1 for DuplicateOutput
    IDXGIOutput1* output1 = nullptr;
    hr = output->QueryInterface(__uuidof(IDXGIOutput1), (void**)&output1);
    output->Release();

    if (FAILED(hr)) {
        ReleaseCaptureResources();
        Napi::Error::New(env, "Failed to query IDXGIOutput1 — Desktop Duplication not supported").ThrowAsJavaScriptException();
        return Napi::Boolean::New(env, false);
    }

    hr = output1->DuplicateOutput(g_d3dDevice, &g_outputDuplication);
    output1->Release();

    if (FAILED(hr)) {
        ReleaseCaptureResources();
        std::string errorMessage = "DuplicateOutput failed (HRESULT: " + std::to_string(hr) + ")";

        if (hr == DXGI_ERROR_NOT_CURRENTLY_AVAILABLE) {
            errorMessage += " — too many applications using Desktop Duplication";
        } else if (hr == E_ACCESSDENIED) {
            errorMessage += " — access denied (may need to run as admin or outside secure desktop)";
        }

        Napi::Error::New(env, errorMessage).ThrowAsJavaScriptException();
        return Napi::Boolean::New(env, false);
    }

    // Create a CPU-readable staging texture matching the display dimensions
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

    g_isCapturing = true;
    return Napi::Boolean::New(env, true);
}

// ---------------------------------------------------------------------------
// stopCapture()
// ---------------------------------------------------------------------------

Napi::Value StopCapture(const Napi::CallbackInfo& info) {
    std::lock_guard<std::mutex> lock(g_captureMutex);
    ReleaseCaptureResources();
    return info.Env().Undefined();
}

// ---------------------------------------------------------------------------
// getLatestFrame()
// ---------------------------------------------------------------------------

Napi::Value GetLatestFrame(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    std::lock_guard<std::mutex> lock(g_captureMutex);

    if (!g_isCapturing || !g_outputDuplication) {
        return env.Null();
    }

    IDXGIResource* desktopResource = nullptr;
    DXGI_OUTDUPL_FRAME_INFO frameInfo;

    // Try to acquire the next frame with a short timeout (0ms = non-blocking)
    HRESULT hr = g_outputDuplication->AcquireNextFrame(0, &frameInfo, &desktopResource);

    if (hr == DXGI_ERROR_WAIT_TIMEOUT) {
        // No new frame available — this is normal, not an error
        return env.Null();
    }

    if (hr == DXGI_ERROR_ACCESS_LOST) {
        // Desktop Duplication was lost (display mode change, etc.)
        // The caller should stop and restart capture.
        ReleaseCaptureResources();
        return env.Null();
    }

    if (FAILED(hr) || !desktopResource) {
        if (desktopResource) desktopResource->Release();
        return env.Null();
    }

    // Get the ID3D11Texture2D from the desktop resource
    ID3D11Texture2D* desktopTexture = nullptr;
    hr = desktopResource->QueryInterface(__uuidof(ID3D11Texture2D), (void**)&desktopTexture);
    desktopResource->Release();

    if (FAILED(hr) || !desktopTexture) {
        g_outputDuplication->ReleaseFrame();
        return env.Null();
    }

    // Copy the desktop texture to our staging texture (GPU → CPU-readable)
    g_d3dContext->CopyResource(g_stagingTexture, desktopTexture);
    desktopTexture->Release();

    // Map the staging texture to read pixel data
    D3D11_MAPPED_SUBRESOURCE mappedResource;
    hr = g_d3dContext->Map(g_stagingTexture, 0, D3D11_MAP_READ, 0, &mappedResource);

    if (FAILED(hr)) {
        g_outputDuplication->ReleaseFrame();
        return env.Null();
    }

    // Copy pixel data into a Node.js Buffer.
    // The mapped resource may have a different row pitch (stride) than
    // width * 4, so we copy row by row to produce a tightly-packed buffer.
    const UINT bytesPerPixel = 4;
    const UINT tightRowPitch = g_captureWidth * bytesPerPixel;
    const UINT totalBufferSize = tightRowPitch * g_captureHeight;

    Napi::Buffer<uint8_t> frameBuffer = Napi::Buffer<uint8_t>::New(env, totalBufferSize);
    uint8_t* destination = frameBuffer.Data();
    uint8_t* source = static_cast<uint8_t*>(mappedResource.pData);

    const bool rowPitchMatchesTightPacking = (mappedResource.RowPitch == tightRowPitch);

    if (rowPitchMatchesTightPacking) {
        // Fast path: single memcpy
        std::memcpy(destination, source, totalBufferSize);
    } else {
        // Row-by-row copy to strip padding
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

    // Build the result object: { buffer, width, height }
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