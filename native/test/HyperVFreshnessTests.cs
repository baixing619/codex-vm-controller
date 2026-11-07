using System;
using System.Collections.Generic;

static class HyperVFreshnessTests {
    sealed class Device : IHyperVGuestDevice {
        public DateTime Now=new DateTime(2026,1,1,0,0,0,DateTimeKind.Utc);
        public int ReadMilliseconds,PositionMilliseconds,Clicks,Positions,Keys,Width=16;
        public Action AfterPosition;
        public Exception ReadFailure;
        public HyperVGuestIdentity ReadIdentity(Action validate){Now=Now.AddMilliseconds(ReadMilliseconds);validate();if(ReadFailure!=null)throw ReadFailure;return new HyperVGuestIdentity(ConsoleProtocol.VmId,"vm","settings","service","keyboard","mouse","video",Width,8);}
        public HyperVThumbnail Capture(HyperVGuestIdentity target,Action validate){return new HyperVThumbnail(new byte[target.Width*target.Height*2],0);}
        public uint SetAbsolutePosition(HyperVGuestIdentity target,int x,int y,Action validate){Positions++;Now=Now.AddMilliseconds(PositionMilliseconds);if(AfterPosition!=null)AfterPosition();return 0;}
        public uint ClickButton(HyperVGuestIdentity target,uint button,Action validate){Clicks++;return 0;}
        public uint TypeKey(HyperVGuestIdentity target,uint key,Action validate){Keys++;return 0;}
        public uint TypeText(HyperVGuestIdentity target,string text,Action validate){return 0;}
        public void Dispose(){}
    }
    sealed class Encoder : IHyperVPixelEncoder {
        readonly Device device;public int Milliseconds;
        public Encoder(Device device){this.device=device;}
        public HyperVEncodedImage Encode(byte[] bgra,int width,int height){device.Now=device.Now.AddMilliseconds(Milliseconds);return new HyperVEncodedImage(new byte[]{255,216,255,1,255,217},width,height);}
    }
    static Dictionary<string,object> Args(params object[] pairs){var result=new Dictionary<string,object>();for(int i=0;i<pairs.Length;i+=2)result.Add((string)pairs[i],pairs[i+1]);return result;}
    static void Require(bool result,string message){if(!result)throw new Exception(message);}
    static object Run(HyperVWorkerSurface surface,Device device,string action,Dictionary<string,object> args,Action cancel=null){return surface.ExecuteCancellable(action,args,device.Now.AddSeconds(10),"codex",0,cancel??(()=>{}));}
    static void Refused(Action call,string expected){try{call();throw new Exception("Expected "+expected);}catch(InvalidOperationException error){Require(error.Message==expected,"Wrong refusal: "+error.Message);}}
    static int Main(){try{
        var device=new Device{ReadMilliseconds=3000};var encoder=new Encoder(device){Milliseconds=700};
        var surface=new HyperVWorkerSurface(device,encoder,()=>device.Now);
        Run(surface,device,"capture",Args());
        Run(surface,device,"key",Args("key","Enter"));
        Require(device.Keys==1,"a just-delivered frame expired during its own discovery/encoding");
        Console.WriteLine("PASS 6.7s capture preparation followed by immediate input");

        device.ReadMilliseconds=0;encoder.Milliseconds=0;Run(surface,device,"capture",Args());
        device.ReadMilliseconds=4000;device.PositionMilliseconds=2000;
        Run(surface,device,"click",Args("x",1,"y",1,"button","left"));
        Require(device.Clicks==1,"a consumed frame clock interrupted the admitted click sequence");
        Console.WriteLine("PASS admitted action uses request deadline, not consumed-frame age");

        device.ReadMilliseconds=0;device.PositionMilliseconds=0;Run(surface,device,"capture",Args());device.Now=device.Now.AddSeconds(5);
        Refused(()=>Run(surface,device,"key",Args("key","Enter")),"fresh-frame-required");
        Run(surface,device,"capture",Args());device.Width=32;
        Refused(()=>Run(surface,device,"key",Args("key","Enter")),"input-device-changed");
        Require(device.Keys==1,"expired frame or changed dimensions reached input");
        Console.WriteLine("PASS expired admission and changed dimensions still rejected");

        Run(surface,device,"capture",Args());bool cancelled=false;device.AfterPosition=()=>cancelled=true;
        Refused(()=>Run(surface,device,"click",Args("x",1,"y",1,"button","left"),()=>{if(cancelled)throw new InvalidOperationException("request-cancelled");}),"request-cancelled");
        Require(device.Clicks==1,"cancellation allowed a new ClickButton call");
        Console.WriteLine("PASS cancellation still stops the next native call");

        device.AfterPosition=null;device.PositionMilliseconds=11000;Run(surface,device,"capture",Args());
        Refused(()=>Run(surface,device,"click",Args("x",1,"y",1,"button","left")),"request-expired");
        Require(device.Clicks==1,"request deadline allowed a new ClickButton call");
        Console.WriteLine("PASS request deadline still stops the next native call");

        int ended=0;string reason=null;surface=new HyperVWorkerSurface(device,encoder,()=>device.Now,null,error=>{ended++;reason=error;});
        device.ReadFailure=new HyperVSessionUnavailableException();
        Refused(()=>Run(surface,device,"capture",Args()),"guest-session-unavailable");
        device.ReadFailure=null;
        Refused(()=>Run(surface,device,"capture",Args()),"guest-session-unavailable");
        Require(ended==1&&reason=="guest-session-unavailable","lost bound device silently reopened the session");
        Console.WriteLine("PASS lost bound device terminates the session without rediscovery");
        return 0;
    }catch(Exception error){Console.Error.WriteLine(error.Message);return 1;}}
}
