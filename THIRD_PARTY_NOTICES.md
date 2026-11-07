# Third-party components

The Windows release includes Node.js 24 from the official nodejs.org Windows x64 archive. The packaging job verifies its SHA256 against the same version's official SHASUMS256.txt. Only node.exe, its complete LICENSE and VERSION are bundled under runtime/. Node.js and its included components remain subject to that LICENSE.

The native EXE/DLL files are built from this repository's corresponding C#/C++ sources. They use the host's Hyper-V WMI provider, .NET Framework and Windows Runtime BitmapEncoder APIs under the applicable Microsoft licenses. Windows system libraries, VM images, Windows SDK and Visual Studio are not bundled.

The pixel encoder links the MSVC C++ runtime statically (/MT) under the Visual Studio redistributable code terms applicable to the build tools. The JavaScript service uses only Node built-ins; no npm dependencies are bundled.
