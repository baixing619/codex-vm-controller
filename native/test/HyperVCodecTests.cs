using System;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
static class HyperVCodecTests {
    [DllImport("GuestWgc.dll",CallingConvention=CallingConvention.Cdecl)]static extern int EncodeGuestPixels(byte[] pixels,int w,int h,out IntPtr bytes,out int length,out int width,out int height);
    static void Encode(int width,int height,bool noise){
        byte[] pixels=new byte[width*height*4];uint random=0x976813a9;
        for(int i=0;i<pixels.Length;i++){random^=random<<13;random^=random>>17;random^=random<<5;pixels[i]=noise&&i%4!=3?(byte)random:(byte)255;}
        IntPtr memory=IntPtr.Zero;int length,w,h;int result=EncodeGuestPixels(pixels,width,height,out memory,out length,out w,out h);
        try{
            if(result<0)Marshal.ThrowExceptionForHR(result);
            if(length<=8||length>3*1024*1024||w!=width||h!=height)throw new Exception("bounded native frame dimensions/size");
            var bytes=new byte[length];Marshal.Copy(memory,bytes,0,length);
            if(WgcFrame.ImageMime(bytes)!=(noise?"image/jpeg":"image/png"))throw new Exception("native fallback MIME");
            using(var stream=new MemoryStream(bytes))using(var image=new Bitmap(stream))if(image.Width!=width||image.Height!=height)throw new Exception("decoded native frame size");
            Console.WriteLine("PASS native EncodeGuestPixels "+w+"x"+h+" "+WgcFrame.ImageMime(bytes)+" "+length+" bytes");
        }finally{if(memory!=IntPtr.Zero)Marshal.FreeCoTaskMem(memory);}
    }
    static int Main(){try{Encode(16,9,false);Encode(1920,1080,true);return 0;}catch(Exception error){Console.Error.WriteLine(error);return 1;}}
}
