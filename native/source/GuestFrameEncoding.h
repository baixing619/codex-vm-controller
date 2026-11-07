#pragma once
// Encoding only: takes already-cropped guest pixels, never captures a window.
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Foundation.Collections.h>
#include <winrt/Windows.Graphics.Imaging.h>
#include <winrt/Windows.Storage.Streams.h>
#include <vector>
#include <algorithm>
namespace GuestFrameEncoding {
constexpr uint32_t MaxBytes=3*1024*1024;
struct Result { std::vector<uint8_t> bytes;int width,height;bool jpeg; };
inline std::vector<uint8_t> Encode(const std::vector<uint8_t>& pixels,int width,int height,int outputWidth,int outputHeight,bool jpeg,float quality) {
    using namespace winrt;using namespace winrt::Windows::Graphics::Imaging;using namespace winrt::Windows::Storage::Streams;
    InMemoryRandomAccessStream stream;
    BitmapPropertySet options;
    if(jpeg)options.Insert(L"ImageQuality",BitmapTypedValue(box_value(quality),winrt::Windows::Foundation::PropertyType::Single));
    auto encoder=BitmapEncoder::CreateAsync(jpeg?BitmapEncoder::JpegEncoderId():BitmapEncoder::PngEncoderId(),stream,options).get();
    encoder.SetPixelData(BitmapPixelFormat::Bgra8,BitmapAlphaMode::Ignore,width,height,96,96,pixels);
    encoder.BitmapTransform().ScaledWidth(outputWidth);encoder.BitmapTransform().ScaledHeight(outputHeight);
    encoder.BitmapTransform().InterpolationMode(BitmapInterpolationMode::Fant);encoder.FlushAsync().get();
    auto count=stream.Size();
    if(count>MaxBytes){stream.Close();return {};}
    auto reader=DataReader(stream.GetInputStreamAt(0));
    if(count<8||reader.LoadAsync(static_cast<uint32_t>(count)).get()!=count)throw_hresult(E_FAIL);
    std::vector<uint8_t> bytes(static_cast<size_t>(count));reader.ReadBytes(bytes);reader.Close();stream.Close();return bytes;
}
inline Result EncodeBounded(const std::vector<uint8_t>& pixels,int width,int height) {
    if(width<1||height<1||width>4096||height>4096||pixels.size()!=static_cast<size_t>(width)*height*4)winrt::throw_hresult(E_INVALIDARG);
    double scale=(std::min)(1.0,(std::min)(1920.0/width,1080.0/height));
    int w=(std::max)(1,static_cast<int>(width*scale)),h=(std::max)(1,static_cast<int>(height*scale));
    auto bytes=Encode(pixels,width,height,w,h,false,0);
    if(!bytes.empty())return {std::move(bytes),w,h,false};
    // Preserve dimensions and aspect ratio; bound attempts and protocol size.
    for(float quality:{0.90f,0.75f}){
        bytes=Encode(pixels,width,height,w,h,true,quality);
        if(!bytes.empty())return {std::move(bytes),w,h,true};
    }
    winrt::throw_hresult(HRESULT_FROM_WIN32(ERROR_FILE_TOO_LARGE));
}
}
