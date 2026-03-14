{
  "targets": [
    {
      "target_name": "dxgi_capture",
      "sources": ["src/dxgi_capture.cpp"],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
      "conditions": [
        [
          "OS=='win'",
          {
            "libraries": [
              "d3d11.lib",
              "dxgi.lib"
            ]
          }
        ]
      ]
    }
  ]
}
