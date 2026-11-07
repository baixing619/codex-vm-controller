using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

static class HyperVWorkerTests {
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
    static extern bool WaitNamedPipe(string pipe,uint timeout);
    [DllImport("ntdll.dll")]
    static extern int NtQueryObject(Microsoft.Win32.SafeHandles.SafePipeHandle handle,int infoClass,IntPtr buffer,int length,out int needed);
    static string OwnPipeObjectName(NamedPipeServerStream server){
        IntPtr buffer=Marshal.AllocHGlobal(4096);
        try{
            int needed;int status=NtQueryObject(server.SafePipeHandle,1,buffer,4096,out needed);
            if(status!=0)return "ntstatus:0x"+unchecked((uint)status).ToString("X8");
            int length=(ushort)Marshal.ReadInt16(buffer);IntPtr text=Marshal.ReadIntPtr(buffer,IntPtr.Size==8?8:4);
            if(length<0||length>4000||text.ToInt64()<buffer.ToInt64()||text.ToInt64()+length>buffer.ToInt64()+4096)return "invalid-object-name";
            return Marshal.PtrToStringUni(text,length/2);
        }finally{Marshal.FreeHGlobal(buffer);}
    }
    sealed class FakeDevice : IHyperVGuestDevice {
        public HyperVGuestIdentity Identity = NewIdentity(16,8);
        public int Positions,Clicks,Keys,Captures,Reads;
        public int LastX,LastY;public uint LastButton,LastKey,PositionResult;
        public readonly List<string> Texts=new List<string>();
        public Action AfterPosition,AfterText,AfterCapture;
        public Exception TextFailure;
        public ManualResetEvent TextEntered,TextRelease;
        public HyperVGuestIdentity ReadIdentity(Action validate){Reads++;return Identity;}
        public HyperVThumbnail Capture(HyperVGuestIdentity target,Action validate){
            Captures++;var raw=new byte[target.Width*target.Height*2+4];raw[0]=0;raw[1]=248;
            if(AfterCapture!=null)AfterCapture();return new HyperVThumbnail(raw,0);
        }
        public uint SetAbsolutePosition(HyperVGuestIdentity target,int x,int y,Action validate){Positions++;LastX=x;LastY=y;if(AfterPosition!=null)AfterPosition();return PositionResult;}
        public uint ClickButton(HyperVGuestIdentity target,uint button,Action validate){Clicks++;LastButton=button;return 0;}
        public uint TypeKey(HyperVGuestIdentity target,uint key,Action validate){Keys++;LastKey=key;return 0;}
        public uint TypeText(HyperVGuestIdentity target,string text,Action validate){
            Texts.Add(text);if(TextEntered!=null)TextEntered.Set();
            if(TextRelease!=null&&!TextRelease.WaitOne(4000))throw new Exception("fake provider was never released");
            if(TextFailure!=null)throw TextFailure;
            if(AfterText!=null)AfterText();return 0;
        }
        public void Dispose(){}
    }
    sealed class FakeEncoder : IHyperVPixelEncoder {
        public int Width,Height;public Action DuringEncode;
        public HyperVEncodedImage Encode(byte[] bgra,int width,int height){
            if(DuringEncode!=null)DuringEncode();
            return new HyperVEncodedImage(new byte[]{255,216,255,1,255,217},Width==0?width:Width,Height==0?height:Height);
        }
    }
    sealed class EndAfterNativeEntry : TextReader {
        readonly string request;readonly ManualResetEvent entered;int count;
        public EndAfterNativeEntry(string request,ManualResetEvent entered){this.request=request;this.entered=entered;}
        public override string ReadLine(){if(count++==0)return request;if(!entered.WaitOne(3000))throw new Exception("native call did not start");return null;}
    }
    static HyperVGuestIdentity NewIdentity(int width,int height,string keyboard="keyboard"){
        return new HyperVGuestIdentity(ConsoleProtocol.VmId,"vm","settings","service",keyboard,"mouse","video",width,height);
    }
    static Dictionary<string,object> Args(params object[] values){var d=new Dictionary<string,object>();for(int i=0;i<values.Length;i+=2)d.Add((string)values[i],values[i+1]);return d;}
    static void Require(bool condition,string message){if(!condition)throw new Exception(message);}
    static object Run(HyperVWorkerSurface surface,string action,Dictionary<string,object> args,Action validate=null,DateTime? deadline=null){
        return surface.ExecuteCancellable(action,args,deadline??DateTime.UtcNow.AddSeconds(10),"codex",0,validate??(()=>{}));
    }
    static void Capture(HyperVWorkerSurface surface){Run(surface,"capture",Args());}
    static void Refused(Action work,string expected){try{work();throw new Exception("Expected refusal: "+expected);}catch(InvalidOperationException e){Require(e.Message.Contains(expected),"Wrong refusal: "+e.Message);}}
    static Dictionary<string,object> Json(object value){return new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(new JavaScriptSerializer().Serialize(value));}

    static void PixelBoundaries(){
        byte[] raw={0,248,224,7,31,0,255,255,19,20,21,22};int trailing;
        byte[] actual=HyperVRgb565.ToBgra(raw,2,2,out trailing);
        byte[] expected={0,0,255,255,0,255,0,255,255,0,0,255,255,255,255,255};
        Require(trailing==4&&actual.Length==expected.Length,"RGB565 trailer or output length wrong");
        for(int i=0;i<expected.Length;i++)Require(actual[i]==expected[i],"RGB565 offset/channel/row mismatch at "+i);
        Require(HyperVRgb565.ToBgra(new byte[8],2,2,out trailing).Length==16&&trailing==0,"untrailed RGB565 rejected");
        foreach(int length in new[]{0,7,9,10,11,13})Refused(()=>HyperVRgb565.ToBgra(new byte[length],2,2,out trailing),"invalid-rgb565-length");
        Refused(()=>HyperVRgb565.ToBgra(raw,0,2,out trailing),"invalid-guest-dimensions");
    }
    static void CancelBetweenMouseCalls(){
        var device=new FakeDevice();var surface=new HyperVWorkerSurface(device,new FakeEncoder());Capture(surface);
        bool cancelled=false;device.AfterPosition=()=>cancelled=true;
        try{Run(surface,"click",Args("x",2,"y",3,"button","left"),()=>{if(cancelled)throw new InvalidOperationException("request-cancelled");});throw new Exception("cancellation was ignored");}
        catch(InvalidOperationException error){
            Require(error.Message=="request-cancelled","wrong cancel error");
            var receipt=Json(new{calls=error.Data["nativeCalls"]});var calls=(System.Collections.ArrayList)receipt["calls"];
            Require(calls.Count==1&&(string)((Dictionary<string,object>)calls[0])["method"]=="SetAbsolutePosition","cancellation lost the native call that already returned");
        }
        Require(device.Positions==1&&device.Clicks==0,"cancelled position was followed by a click");
        Refused(()=>Run(surface,"key",Args("key","Enter")),"fresh-frame-required");
    }
    static void NativeFailureStopsMouseSequence(){
        var device=new FakeDevice{PositionResult=32769};var surface=new HyperVWorkerSurface(device,new FakeEncoder());Capture(surface);
        Refused(()=>Run(surface,"click",Args("x",1,"y",1,"button","right")),"32769");
        Require(device.Clicks==0,"failed SetAbsolutePosition was followed by ClickButton");
    }
    static void WholeTextPreflightAndChunkCancellation(){
        var device=new FakeDevice();var surface=new HyperVWorkerSurface(device,new FakeEncoder());Capture(surface);
        Refused(()=>Run(surface,"type_text",Args("text","safe-prefix\u767d")),"unicode-text-unsupported");
        Require(device.Texts.Count==0,"non-ASCII validation typed a prefix");
        Capture(surface);string text=new string('x',1000);var result=Json(Run(surface,"type_text",Args("text",text)));
        Require(device.Texts.Count==2&&device.Texts[0]==new string('x',512)&&device.Texts[1]==new string('x',488),"ASCII 1000 did not retain provider-sized chunks");
        Require(object.Equals(result["guestEffectVerified"],false)&&object.Equals(result["literalTextVerified"],false),"provider acceptance became guest verification");
        device.Texts.Clear();Capture(surface);bool cancelled=false;device.AfterText=()=>cancelled=true;
        Refused(()=>Run(surface,"type_text",Args("text",text),()=>{if(cancelled)throw new InvalidOperationException("request-cancelled");}),"request-cancelled");
        Require(device.Texts.Count==1&&device.Texts[0].Length==512,"cancellation between text chunks was ignored");
    }
    static void EofWaitsForNativeReturn(){
        using(var entered=new ManualResetEvent(false))using(var release=new ManualResetEvent(false)){
            var device=new FakeDevice{TextEntered=entered,TextRelease=release};var surface=new HyperVWorkerSurface(device,new FakeEncoder());Capture(surface);
            string line=new JavaScriptSerializer().Serialize(new{id="blocked",vmId=ConsoleProtocol.VmId,source="codex",controlEpoch=0,action="type_text",args=new{text="BX-VM-20261103"},expiresAtUtcMs=(long)(DateTime.UtcNow.AddSeconds(3)-new DateTime(1970,1,1,0,0,0,DateTimeKind.Utc)).TotalMilliseconds});
            var output=new StringWriter();var reader=new EndAfterNativeEntry(line,entered);
            Task run=Task.Factory.StartNew(()=>ConsoleProtocol.Run(reader,output,surface,true));
            Require(entered.WaitOne(3000),"TypeText never entered");
            try{
                Require(!run.Wait(200),"EOF falsely certified drain while TypeText was still in the provider");
                Refused(()=>Run(surface,"key",Args("key","Enter")),"request-busy");
            }finally{release.Set();}
            Require(run.Wait(3000),"EOF did not finish after the provider returned");
            Require(device.Texts.Count==1&&device.Keys==0,"blocked native call overlapped another input");
            Require(output.ToString().Length==0,"closed channel published a late success");
        }
    }
    static void FreshnessStartsAfterCapture(){
        DateTime now=DateTime.UtcNow;var device=new FakeDevice();var encoder=new FakeEncoder();var surface=new HyperVWorkerSurface(device,encoder,()=>now);
        Refused(()=>Run(surface,"key",Args("key","Enter")),"fresh-frame-required");
        encoder.DuringEncode=()=>now=now.AddSeconds(5);Capture(surface);
        Run(surface,"key",Args("key","Enter"));
        Require(device.Keys==1,"a completed frame was already expired on delivery");
        encoder.DuringEncode=null;Capture(surface);now=now.AddMilliseconds(4999);Run(surface,"key",Args("key","Enter"));
        Require(device.LastKey==13,"fresh Enter was not VK_RETURN");
    }
    static void DeviceOrResolutionChangeRefusesInput(){
        var device=new FakeDevice();var surface=new HyperVWorkerSurface(device,new FakeEncoder());Capture(surface);
        device.Identity=NewIdentity(16,8,"replacement-keyboard");Refused(()=>Run(surface,"key",Args("key","Enter")),"input-device-changed");
        Capture(surface);device.Identity=NewIdentity(32,8,"replacement-keyboard");Refused(()=>Run(surface,"click",Args("x",1,"y",1,"button","left")),"input-device-changed");
        Require(device.Keys==0&&device.Positions==0,"changed target received stale-frame input");
        device.AfterCapture=()=>device.Identity=NewIdentity(64,8);Refused(()=>Capture(surface),"capture-device-changed");
    }
    static void EncodedCoordinatesAndNativeReceipts(){
        var device=new FakeDevice();var surface=new HyperVWorkerSurface(device,new FakeEncoder{Width=8,Height=4});var capture=Json(Run(surface,"capture",Args()));
        Require((int)capture["width"]==8&&(int)capture["height"]==4&&(int)capture["trailingBytes"]==4,"capture misreported encoded dimensions/trailer");
        var result=Json(Run(surface,"click",Args("x",7,"y",3,"button","right")));
        Require(device.LastX==14&&device.LastY==6&&device.LastButton==2,"encoded coordinates did not map into actual guest pixels");
        var calls=(System.Collections.ArrayList)result["nativeCalls"];
        Require(calls.Count==2&&(string)((Dictionary<string,object>)calls[0])["method"]=="SetAbsolutePosition"&&(int)((Dictionary<string,object>)calls[1])["returnValue"]==0,"native receipt did not retain actual sequence/result");
        Refused(()=>Run(surface,"key",Args("key","Enter")),"fresh-frame-required");
    }
    static void DeadlineAndFixedVm(){
        var device=new FakeDevice();var surface=new HyperVWorkerSurface(device,new FakeEncoder());
        Refused(()=>Run(surface,"capture",Args(),null,DateTime.UtcNow.AddSeconds(-1)),"request-expired");Require(device.Reads==0,"expired request reached device");
        device.Identity=new HyperVGuestIdentity("other-vm","vm","settings","service","keyboard","mouse","video",16,8);
        Refused(()=>Capture(surface),"target-mismatch");Require(device.Captures==0,"foreign VM was captured");
    }
    static void EpochAndSourceSemantics(){
        var device=new FakeDevice();var surface=new HyperVWorkerSurface(device,new FakeEncoder());Capture(surface);
        Refused(()=>surface.ExecuteCancellable("key",Args("key","Enter"),DateTime.UtcNow.AddSeconds(3),"codex",1,()=>{}),"frame-epoch-mismatch");
        Require(device.Keys==0,"a frame survived its cancellation epoch");
        Refused(()=>Run(surface,"key",Args("key","Enter")),"fresh-frame-required");
        Capture(surface);surface.ExecuteCancellable("key",Args("key","Enter"),DateTime.UtcNow.AddSeconds(3),"agent",0,()=>{});
        Require(device.Keys==1,"activity source incorrectly became an authorization selection");
    }
    static void AsyncJobCancellationAndFatalState(){
        int enteredInvocation=0;
        try{HyperVInvocationBoundary.Call<int>(()=>{enteredInvocation++;throw new COMException("fake transport detail must not escape",unchecked((int)0x800706BE));});throw new Exception("uncertain invocation was accepted");}
        catch(HyperVDrainUnconfirmedException error){Require(enteredInvocation==1&&(string)error.Data["nativeHResult"]=="0x800706BE"&&error.InnerException==null,"invocation ambiguity was not isolated from provider detail");}
        using(var entered=new ManualResetEvent(false))using(var release=new ManualResetEvent(false)){
            int reads=0;bool cancelled=false;
            Task task=Task.Factory.StartNew(()=>Refused(()=>HyperVJobCompletion.Wait(()=>new HyperVJobStatus(++reads==1?(ushort)4:(ushort)7,0),()=>{if(cancelled)throw new InvalidOperationException("request-cancelled");},()=>{entered.Set();Require(release.WaitOne(3000),"job never released");}),"request-cancelled"));
            Require(entered.WaitOne(2000),"job observation did not start");cancelled=true;
            try{Require(!task.Wait(150),"cancelled active job was falsely drained");}finally{release.Set();}
            Require(task.Wait(2000)&&reads==2,"cancelled job was not followed to its real terminal state");
        }
        Refused(()=>HyperVJobCompletion.Wait(()=>new HyperVJobStatus(7,null),()=>{},()=>{}),"execution-drain-unconfirmed");
        Refused(()=>HyperVJobCompletion.Wait(()=>{throw new IOException();},()=>{},()=>{}),"execution-drain-unconfirmed");
        var failure=new HyperVDrainUnconfirmedException();failure.Data["nativeCalls"]=new object[]{new{method="TypeText",returnValue=4096}};
        var device=new FakeDevice{TextFailure=failure};int fatal=0;var surface=new HyperVWorkerSurface(device,new FakeEncoder(),null,null,_=>fatal++);Capture(surface);
        try{Run(surface,"type_text",Args("text","x"));throw new Exception("untracked job was accepted");}
        catch(HyperVDrainUnconfirmedException error){Require(((List<object>)error.Data["nativeCalls"]).Count==1,"4096 receipt was lost");}
        int readsBefore=device.Reads;Refused(()=>Capture(surface),"execution-drain-unconfirmed");
        Require(fatal==1&&device.Reads==readsBefore,"uncertain execution did not permanently close the surface");
    }
    static void RealPipeEofDrainsWithoutCloseFailure(){
        using(var entered=new ManualResetEvent(false))using(var release=new ManualResetEvent(false)){
            var device=new FakeDevice{TextEntered=entered,TextRelease=release};var surface=new HyperVWorkerSurface(device,new FakeEncoder());Capture(surface);
            // The test executor runs in an AppContainer; LOCAL keeps both ends
            // of this test-only pipe in the same permitted named-object scope.
            string pipeName=@"LOCAL\HyperVWorkerTest-"+Guid.NewGuid().ToString("N");
            var security=new PipeSecurity();security.SetAccessRuleProtection(true,false);
            using(var identity=WindowsIdentity.GetCurrent())security.AddAccessRule(new PipeAccessRule(identity.User,PipeAccessRights.FullControl,AccessControlType.Allow));
            using(var server=new NamedPipeServerStream(pipeName,PipeDirection.InOut,1,PipeTransmissionMode.Byte,PipeOptions.Asynchronous,4096,4096,security)){
                Console.WriteLine("PIPE object="+OwnPipeObjectName(server)+" configured="+pipeName);
                // Publish the listener before a client can spend its connection
                // deadline waiting for a not-yet-started asynchronous accept.
                var accepted=server.BeginWaitForConnection(null,null);
                bool nativeVisible=WaitNamedPipe(@"\\.\pipe\"+pipeName,1);int nativeError=Marshal.GetLastWin32Error();
                Console.WriteLine("PIPE listener visible="+nativeVisible+" win32="+nativeError);
                Task client=Task.Factory.StartNew(()=>{
                    using(var pipe=new NamedPipeClientStream(".",pipeName,PipeDirection.InOut,PipeOptions.Asynchronous)){
                        pipe.Connect(5000);HyperVGuestWorker.RunConnectedSession(pipe,(reader,writer)=>ConsoleProtocol.Run(reader,writer,surface,true));
                    }
                });
                if(!accepted.AsyncWaitHandle.WaitOne(7000)){
                    if(client.IsFaulted)throw new Exception("local pipe client failed",client.Exception);
                    throw new Exception("local pipe connection timed out; client task="+client.Status);
                }
                server.EndWaitForConnection(accepted);accepted.AsyncWaitHandle.Close();
                var request=new JavaScriptSerializer().Serialize(new{id="pipe-close",vmId=ConsoleProtocol.VmId,source="codex",controlEpoch=0,action="type_text",args=new{text="x"}});
                byte[] line=new UTF8Encoding(false).GetBytes(request+"\n");server.Write(line,0,line.Length);server.Flush();
                Require(entered.WaitOne(2000),"pipe request did not enter provider");server.Dispose();
                try{Require(!client.Wait(150),"closed pipe falsely drained an active native call");}finally{release.Set();}
                Require(client.Wait(2000),"normal pipe EOF did not drain cleanly");
                Require(device.Texts.Count==1,"pipe test native sequence wrong");
            }
        }
    }
    static void Check(string name,Action test){Console.WriteLine("START "+name);test();Console.WriteLine("PASS "+name);}
    static int Main(string[] args){try{
        Check("PixelBoundaries",PixelBoundaries);Check("CancelBetweenMouseCalls",CancelBetweenMouseCalls);Check("NativeFailureStopsMouseSequence",NativeFailureStopsMouseSequence);
        Check("WholeTextPreflightAndChunkCancellation",WholeTextPreflightAndChunkCancellation);Check("EofWaitsForNativeReturn",EofWaitsForNativeReturn);Check("FreshnessStartsAfterCapture",FreshnessStartsAfterCapture);
        Check("DeviceOrResolutionChangeRefusesInput",DeviceOrResolutionChangeRefusesInput);Check("EncodedCoordinatesAndNativeReceipts",EncodedCoordinatesAndNativeReceipts);Check("DeadlineAndFixedVm",DeadlineAndFixedVm);
        Check("EpochAndSourceSemantics",EpochAndSourceSemantics);Check("AsyncJobCancellationAndFatalState",AsyncJobCancellationAndFatalState);
        if(args.Length==1&&args[0]=="--logic-only"){Console.WriteLine("PASS 11 logic groups; actual local pipe fixture explicitly not run.");return 0;}
        Check("RealPipeEofDrainsWithoutCloseFailure",RealPipeEofDrainsWithoutCloseFailure);
        Console.WriteLine("HyperV worker tests passed (12 groups): RGB565 offset/trailer, cancellation receipts, real drain, ASCII preflight/chunks, freshness, device identity, encoded mapping, native results, fixed VM/deadline, frame epoch/activity source, async jobs/fatal state, actual local pipe EOF. Fake devices only; no WMI/COM/GUI.");return 0;
    }catch(Exception e){Console.Error.WriteLine(e);return 1;}}
}
