// Encodes supplied guest pixels only. No window capture or host input.
#include <windows.h>
#include <winrt/Windows.Foundation.h>
#include <vector>
#include <algorithm>
#include "GuestFrameEncoding.h"
using namespace winrt;
namespace {
void require(bool value,HRESULT error=E_INVALIDARG){if(!value)throw_hresult(error);}
struct Apartment {
  Apartment(){init_apartment(apartment_type::multi_threaded);}
  ~Apartment(){uninit_apartment();}
};
}

extern "C" __declspec(dllexport) HRESULT __cdecl EncodeGuestPixels(const BYTE* bgra,int width,int height,BYTE** bytes,int* length,int* outputWidth,int* outputHeight) noexcept {
  if(!bgra||!bytes||!length||!outputWidth||!outputHeight)return E_POINTER;
  *bytes=nullptr;*length=*outputWidth=*outputHeight=0;
  try {
    require(width>0&&height>0&&width<=4096&&height<=4096);
    Apartment apartment;
    std::vector<uint8_t> pixels(bgra,bgra+static_cast<size_t>(width)*height*4);
    auto encoded=GuestFrameEncoding::EncodeBounded(pixels,width,height);
    auto data=static_cast<BYTE*>(CoTaskMemAlloc(encoded.bytes.size()));require(data!=nullptr,E_OUTOFMEMORY);
    std::copy(encoded.bytes.begin(),encoded.bytes.end(),data);
    *bytes=data;*length=static_cast<int>(encoded.bytes.size());*outputWidth=encoded.width;*outputHeight=encoded.height;return S_OK;
  }catch(...){return to_hresult();}
}
