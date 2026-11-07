// Fixed-VM Hyper-V worker. The only native input targets are this VM's devices.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.IO.Pipes;
using System.Management;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

public sealed class HyperVGuestIdentity {
    public readonly string VmId,VmPath,SettingsPath,ServicePath,KeyboardPath,MousePath,VideoPath;
    public readonly int Width,Height;
    public HyperVGuestIdentity(string vmId,string vmPath,string settingsPath,string servicePath,string keyboardPath,string mousePath,string videoPath,int width,int height){
        VmId=vmId;VmPath=vmPath;SettingsPath=settingsPath;ServicePath=servicePath;KeyboardPath=keyboardPath;MousePath=mousePath;VideoPath=videoPath;Width=width;Height=height;
    }
    public void Validate(){
        if(!string.Equals(VmId,ConsoleProtocol.VmId,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("target-mismatch");
        foreach(string path in new[]{VmPath,SettingsPath,ServicePath,KeyboardPath,MousePath,VideoPath})
            if(string.IsNullOrEmpty(path))throw new InvalidOperationException("guest-device-unavailable");
        HyperVRgb565.ValidateDimensions(Width,Height);
    }
    public bool SameAs(HyperVGuestIdentity other){
        if(other==null||Width!=other.Width||Height!=other.Height)return false;
        string[] a={VmId,VmPath,SettingsPath,ServicePath,KeyboardPath,MousePath,VideoPath};
        string[] b={other.VmId,other.VmPath,other.SettingsPath,other.ServicePath,other.KeyboardPath,other.MousePath,other.VideoPath};
        for(int i=0;i<a.Length;i++)if(!string.Equals(a[i],b[i],StringComparison.OrdinalIgnoreCase))return false;
        return true;
    }
}
public sealed class HyperVThumbnail {
    public readonly byte[] Bytes;public readonly uint ReturnValue;
    public HyperVThumbnail(byte[] bytes,uint returnValue){Bytes=bytes;ReturnValue=returnValue;}
}
public sealed class HyperVEncodedImage {
    public readonly byte[] Bytes;public readonly int Width,Height;
    public HyperVEncodedImage(byte[] bytes,int width,int height){Bytes=bytes;Width=width;Height=height;}
}
public interface IHyperVGuestDevice : IDisposable {
    // A returned 4096 is permitted only after its reported Job has reached a
    // successful terminal state. Untrackable execution must throw the fatal
    // HyperVDrainUnconfirmedException, never return a normal native receipt.
    HyperVGuestIdentity ReadIdentity(Action validate);
    HyperVThumbnail Capture(HyperVGuestIdentity target,Action validate);
    uint SetAbsolutePosition(HyperVGuestIdentity target,int x,int y,Action validate);
    uint ClickButton(HyperVGuestIdentity target,uint button,Action validate);
    uint TypeKey(HyperVGuestIdentity target,uint key,Action validate);
    uint TypeText(HyperVGuestIdentity target,string text,Action validate);
}
public interface IHyperVPixelEncoder {HyperVEncodedImage Encode(byte[] bgra,int width,int height);}
public sealed class HyperVDrainUnconfirmedException : InvalidOperationException {
    public HyperVDrainUnconfirmedException() : base("execution-drain-unconfirmed"){}
}
public sealed class HyperVSessionUnavailableException : InvalidOperationException {
    public HyperVSessionUnavailableException() : base("guest-session-unavailable"){}
}
public sealed class HyperVNativeReceipt {
    public string method;public uint? returnValue;public bool jobCompleted,completionUnknown;
    public int? length,offset,x,y;public uint? button,keyCode;
    public HyperVNativeReceipt(string method,uint? value,bool completed=false){this.method=method;returnValue=value;jobCompleted=completed;completionUnknown=!value.HasValue;}
}
public static class HyperVInvocationBoundary {
    public static T Call<T>(Func<T> invocation){
        try{return invocation();}
        catch(Exception error){
            var uncertain=new HyperVDrainUnconfirmedException();
            uncertain.Data["nativeHResult"]="0x"+unchecked((uint)error.HResult).ToString("X8");
            throw uncertain;
        }
    }
}
public sealed class HyperVJobStatus {
    public readonly ushort State;public readonly uint? ErrorCode;
    public HyperVJobStatus(ushort state,uint? errorCode){State=state;ErrorCode=errorCode;}
}
public static class HyperVJobCompletion {
    public static void Wait(Func<HyperVJobStatus> read,Action validate,Action delay){
        Exception revoked=null;
        Action observe=()=>{try{validate();}catch(Exception error){if(revoked==null)revoked=error;}};
        for(;;){
            observe();HyperVJobStatus status;
            try{status=read();}catch{throw new HyperVDrainUnconfirmedException();}
            observe();
            if(status==null||status.State<2||status.State>11)throw new HyperVDrainUnconfirmedException();
            if(status.State>=7&&status.State<=10){
                if(status.State==7&&!status.ErrorCode.HasValue)throw new HyperVDrainUnconfirmedException();
                if(revoked!=null)throw revoked;
                if(status.State!=7||status.ErrorCode.Value!=0)throw new InvalidOperationException("hyperv-job-failed:"+status.State.ToString(CultureInfo.InvariantCulture)+":"+(status.ErrorCode.HasValue?status.ErrorCode.Value.ToString(CultureInfo.InvariantCulture):"unknown"));
                return;
            }
            try{delay();}catch{throw new HyperVDrainUnconfirmedException();}
        }
    }
}

public static class HyperVRgb565 {
    public static void ValidateDimensions(int width,int height){
        if(width<1||height<1||width>4096||height>4096)throw new InvalidOperationException("invalid-guest-dimensions");
    }
    public static byte[] ToBgra(byte[] raw,int width,int height,out int trailingBytes){
        ValidateDimensions(width,height);int expected=checked(width*height*2);
        if(raw==null||(raw.Length!=expected&&raw.Length!=expected+4))throw new InvalidOperationException("invalid-rgb565-length");
        trailingBytes=raw.Length-expected;var bgra=new byte[checked(width*height*4)];
        // Hyper-V supplies tightly packed little-endian pixels starting at offset 0.
        // Some providers append four bytes; these are not a header or row padding.
        for(int y=0;y<height;y++)for(int x=0;x<width;x++){
            int src=(y*width+x)*2,dst=(y*width+x)*4,value=raw[src]|(raw[src+1]<<8);
            int b=value&31,g=(value>>5)&63,r=(value>>11)&31;
            bgra[dst]=(byte)((b<<3)|(b>>2));bgra[dst+1]=(byte)((g<<2)|(g>>4));
            bgra[dst+2]=(byte)((r<<3)|(r>>2));bgra[dst+3]=255;
        }
        return bgra;
    }
}

public sealed class HyperVNativePixelEncoder : IHyperVPixelEncoder {
    [DllImport("GuestWgc.dll",CallingConvention=CallingConvention.Cdecl)]
    static extern int EncodeGuestPixels([In]byte[] bgra,int width,int height,out IntPtr bytes,out int length,out int outWidth,out int outHeight);
    public HyperVEncodedImage Encode(byte[] bgra,int width,int height){
        HyperVRgb565.ValidateDimensions(width,height);
        if(bgra==null||bgra.Length!=checked(width*height*4))throw new InvalidOperationException("invalid-bgra-length");
        IntPtr data=IntPtr.Zero;int length=0,outWidth=0,outHeight=0;
        try{
            int hr=EncodeGuestPixels(bgra,width,height,out data,out length,out outWidth,out outHeight);
            if(hr<0)throw new InvalidOperationException("guest-encode-failed:0x"+unchecked((uint)hr).ToString("X8"));
            HyperVRgb565.ValidateDimensions(outWidth,outHeight);
            if(data==IntPtr.Zero||length<4||length>3*1024*1024)throw new InvalidOperationException("invalid-encoded-frame");
            var bytes=new byte[length];Marshal.Copy(data,bytes,0,length);WgcFrame.ImageMime(bytes);
            return new HyperVEncodedImage(bytes,outWidth,outHeight);
        }finally{if(data!=IntPtr.Zero)Marshal.FreeCoTaskMem(data);}
    }
}

public sealed class HyperVWorkerSurface : IConsoleSurface,ICancellableConsoleSurface {
    sealed class Frame {
        public HyperVGuestIdentity Identity;public DateTime ReadyAt;public int Width,Height;public long Epoch;
    }
    readonly IHyperVGuestDevice device;readonly IHyperVPixelEncoder encoder;readonly Func<DateTime> clock;readonly Action validateLifetime;readonly Action<string> failWorker;
    int busy,drainUnconfirmed;Frame frame;
    public HyperVWorkerSurface(IHyperVGuestDevice device,IHyperVPixelEncoder encoder,Func<DateTime> clock=null,Action validateLifetime=null,Action<string> failWorker=null){
        if(device==null||encoder==null)throw new ArgumentNullException();
        this.device=device;this.encoder=encoder;this.clock=clock??(()=>DateTime.UtcNow);this.validateLifetime=validateLifetime??(()=>{});this.failWorker=failWorker??(_=>{});
    }
    public HyperVGuestIdentity Initialize(Action validate){
        validateLifetime();validate();var identity=device.ReadIdentity(()=>{validateLifetime();validate();});validateLifetime();validate();identity.Validate();return identity;
    }
    public object Capture(){throw new InvalidOperationException("request-scope-required");}
    public object Perform(string action,Dictionary<string,object> args){throw new InvalidOperationException("request-scope-required");}
    static bool Exact(Dictionary<string,object> args,params string[] keys){
        if(args==null||args.Count!=keys.Length)return false;foreach(string key in keys)if(!args.ContainsKey(key))return false;return true;
    }
    static uint KeyCode(string key){
        switch(key){case "Shift":return 16;case "Space":return 32;case "Enter":return 13;case "Escape":return 27;case "Tab":return 9;case "Backspace":return 8;
            case "ArrowUp":return 38;case "ArrowDown":return 40;case "ArrowLeft":return 37;case "ArrowRight":return 39;default:throw new InvalidOperationException("invalid-action");}
    }
    static void ValidateAction(string action,Dictionary<string,object> args){
        if(action=="capture"){if(!Exact(args))throw new InvalidOperationException("invalid-action");return;}
        if(action=="click"){
            if(!Exact(args,"x","y","button")||!(args["x"] is int)||!(args["y"] is int)||(int)args["x"]<0||(int)args["y"]<0
                ||((args["button"] as string)!="left"&&(args["button"] as string)!="right"))throw new InvalidOperationException("invalid-action");return;
        }
        if(action=="key"){if(!Exact(args,"key"))throw new InvalidOperationException("invalid-action");KeyCode(args["key"] as string);return;}
        if(action=="type_text"){
            string text;if(!Exact(args,"text")||(text=args["text"] as string)==null||text.Length<1||text.Length>1000)throw new InvalidOperationException("invalid-action");
            // Preflight the entire value before sending even the first provider chunk.
            foreach(char c in text)if(c<32||c>126)throw new InvalidOperationException("unicode-text-unsupported");return;
        }
        throw new InvalidOperationException("invalid-action");
    }
    static void NativeResult(string method,uint value){
        if(value!=0&&value!=4096)throw new InvalidOperationException("hyperv-"+method+":"+value.ToString(CultureInfo.InvariantCulture));
    }
    static void CallNative(string method,Func<uint> call,Action validate,List<object> calls,Action<HyperVNativeReceipt> details){
        validate();uint value;
        try{value=call();}
        catch(Exception error){
            var pending=error.Data["nativeCalls"] as System.Collections.IEnumerable;
            if(pending!=null)foreach(object item in pending){var receipt=item as HyperVNativeReceipt;if(receipt!=null&&receipt.method==method)details(receipt);}
            throw;
        }
        var returned=new HyperVNativeReceipt(method,value,value==4096);details(returned);calls.Add(returned);validate();NativeResult(method,value);
    }
    void Fresh(Frame saved,long epoch){
        if(saved==null)throw new InvalidOperationException("fresh-frame-required");
        if(saved.Epoch!=epoch)throw new InvalidOperationException("frame-epoch-mismatch");
        double age=(clock()-saved.ReadyAt).TotalMilliseconds;
        if(age<0||age>=5000)throw new InvalidOperationException("fresh-frame-required");
    }
    public object ExecuteCancellable(string action,Dictionary<string,object> args,DateTime deadline,string source,long controlEpoch,Action validateCancellation){
        if(Interlocked.CompareExchange(ref busy,1,0)!=0)throw new InvalidOperationException("request-busy");
        var nativeCalls=new List<object>();
        try{
            int terminal=Interlocked.CompareExchange(ref drainUnconfirmed,0,0);
            if(terminal==1)throw new HyperVDrainUnconfirmedException();
            if(terminal==2)throw new HyperVSessionUnavailableException();
            // Consume before any refusal, including cancellation or invalid text.
            Frame saved=frame;frame=null;
            Action validate=()=>{validateLifetime();if(validateCancellation!=null)validateCancellation();if(clock()>deadline)throw new InvalidOperationException("request-expired");};
            validate();
            if(source!="codex"&&source!="agent")throw new InvalidOperationException("invalid-control-source");
            if(controlEpoch<0)throw new InvalidOperationException("invalid-control-epoch");
            ValidateAction(action,args);
            if(action=="capture"){
                validate();var identity=device.ReadIdentity(validate);validate();identity.Validate();
                validate();var thumbnail=device.Capture(identity,validate);
                nativeCalls.Add(new HyperVNativeReceipt("GetVirtualSystemThumbnailImage",thumbnail.ReturnValue,thumbnail.ReturnValue==4096));validate();NativeResult("GetVirtualSystemThumbnailImage",thumbnail.ReturnValue);
                int trailing;var bgra=HyperVRgb565.ToBgra(thumbnail.Bytes,identity.Width,identity.Height,out trailing);
                validate();var encoded=encoder.Encode(bgra,identity.Width,identity.Height);validate();
                if(encoded==null||encoded.Bytes==null||encoded.Bytes.Length>3*1024*1024)throw new InvalidOperationException("invalid-encoded-frame");
                HyperVRgb565.ValidateDimensions(encoded.Width,encoded.Height);string mime=WgcFrame.ImageMime(encoded.Bytes);
                validate();var after=device.ReadIdentity(validate);validate();after.Validate();
                if(!identity.SameAs(after))throw new InvalidOperationException("capture-device-changed");
                string data=Convert.ToBase64String(encoded.Bytes);validate();
                // Match the existing console: freshness is an admission window
                // for a completed frame, not a budget for discovery or encoding.
                frame=new Frame{Identity=identity,ReadyAt=clock(),Width=encoded.Width,Height=encoded.Height,Epoch=controlEpoch};
                return new{mime,width=encoded.Width,height=encoded.Height,data,captureBackend="hyperv-thumbnail-rgb565",trailingBytes=trailing,guestWidth=identity.Width,guestHeight=identity.Height,nativeCalls};
            }
            Fresh(saved,controlEpoch);
            Action inputValidate=validate;
            inputValidate();var current=device.ReadIdentity(inputValidate);inputValidate();current.Validate();
            if(!saved.Identity.SameAs(current))throw new InvalidOperationException("input-device-changed");
            if(action=="click"){
                int x=(int)args["x"],y=(int)args["y"];
                if(x>=saved.Width||y>=saved.Height)throw new InvalidOperationException("click-outside-frame");
                int guestX=(int)((long)x*current.Width/saved.Width),guestY=(int)((long)y*current.Height/saved.Height);
                uint button=(args["button"] as string)=="left"?1u:2u;
                CallNative("SetAbsolutePosition",()=>device.SetAbsolutePosition(current,guestX,guestY,inputValidate),inputValidate,nativeCalls,receipt=>{receipt.x=guestX;receipt.y=guestY;});
                CallNative("ClickButton",()=>device.ClickButton(current,button,inputValidate),inputValidate,nativeCalls,receipt=>receipt.button=button);
            }else if(action=="key"){
                uint key=KeyCode(args["key"] as string);
                CallNative("TypeKey",()=>device.TypeKey(current,key,inputValidate),inputValidate,nativeCalls,receipt=>receipt.keyCode=key);
            }else{
                string text=(string)args["text"];
                for(int offset=0;offset<text.Length;offset+=512){
                    string chunk=text.Substring(offset,Math.Min(512,text.Length-offset));
                    CallNative("TypeText",()=>device.TypeText(current,chunk,inputValidate),inputValidate,nativeCalls,receipt=>{receipt.offset=offset;receipt.length=chunk.Length;});
                }
            }
            return new{acceptedByAdapter=true,guestEffectVerified=false,literalTextVerified=false,inputBackend="hyperv-synthetic-devices",nativeCalls};
        }catch(Exception error){
            var pending=error.Data["nativeCalls"] as System.Collections.IEnumerable;
            if(pending!=null)foreach(object item in pending)nativeCalls.Add(item);
            if(nativeCalls.Count>0)error.Data["nativeCalls"]=nativeCalls;
            if(error is HyperVDrainUnconfirmedException||error is HyperVSessionUnavailableException){
                frame=null;int terminal=error is HyperVDrainUnconfirmedException?1:2;
                if(Interlocked.Exchange(ref drainUnconfirmed,terminal)==0)failWorker(error.Message);
            }
            throw;
        }finally{Interlocked.Exchange(ref busy,0);}
    }
}

public sealed class HyperVManagementDevice : IHyperVGuestDevice {
    readonly ManagementScope scope=new ManagementScope(@"\\.\root\virtualization\v2");
    bool connected;HyperVGuestIdentity boundIdentity;
    void Connect(Action validate){if(connected)return;validate();scope.Connect();validate();connected=true;}
    static T Around<T>(Action validate,Func<T> call){
        validate();T result=call();
        try{validate();return result;}catch{var resource=result as IDisposable;if(resource!=null)resource.Dispose();throw;}
    }
    ManagementObject QueryOne(string query,Action validate){
        using(var searcher=new ManagementObjectSearcher(scope,new ObjectQuery(query)))
        using(var results=Around(validate,()=>searcher.Get())){
            ManagementObject found=null;
            try{
                using(var iterator=results.GetEnumerator()){
                    while(Around(validate,()=>iterator.MoveNext())){
                        var item=(ManagementObject)iterator.Current;
                        if(found!=null){item.Dispose();throw new InvalidOperationException("guest-device-ambiguous");}
                        found=item;
                    }
                }
                if(found==null)throw new InvalidOperationException("guest-device-unavailable");
                return found;
            }catch{if(found!=null)found.Dispose();throw;}
        }
    }
    public HyperVGuestIdentity ReadIdentity(Action validate){
        Connect(validate);string id=ConsoleProtocol.VmId;
        if(boundIdentity!=null){
            // Discovery belongs to this session's initialization. Refresh only
            // the exact bound display; never rediscover or select a replacement.
            HyperVGuestIdentity result;
            validate();
            using(var video=new ManagementObject(scope,new ManagementPath(boundIdentity.VideoPath),null)){
                try{
                    video.Get();
                    result=new HyperVGuestIdentity(boundIdentity.VmId,boundIdentity.VmPath,boundIdentity.SettingsPath,boundIdentity.ServicePath,
                        boundIdentity.KeyboardPath,boundIdentity.MousePath,boundIdentity.VideoPath,
                        Convert.ToInt32(video["CurrentHorizontalResolution"],CultureInfo.InvariantCulture),Convert.ToInt32(video["CurrentVerticalResolution"],CultureInfo.InvariantCulture));
                    result.Validate();
                }catch(ManagementException){throw new HyperVSessionUnavailableException();}
                catch(COMException){throw new HyperVSessionUnavailableException();}
                catch(InvalidOperationException){throw new HyperVSessionUnavailableException();}
                catch(FormatException){throw new HyperVSessionUnavailableException();}
                catch(InvalidCastException){throw new HyperVSessionUnavailableException();}
                catch(OverflowException){throw new HyperVSessionUnavailableException();}
            }
            validate();return result;
        }
        using(var vm=QueryOne("SELECT * FROM Msvm_ComputerSystem WHERE Name='"+id+"'",validate)){
            if(!string.Equals(Convert.ToString(vm["Name"],CultureInfo.InvariantCulture),id,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("target-mismatch");
            if(Convert.ToUInt16(vm["EnabledState"],CultureInfo.InvariantCulture)!=2)throw new InvalidOperationException("guest-not-running");
            // SettingsDefineState selects the current configuration, not snapshots.
            string associated="ASSOCIATORS OF {"+vm.Path.RelativePath+"} WHERE ";
            string settingQuery=associated+"AssocClass=Msvm_SettingsDefineState ResultClass=Msvm_VirtualSystemSettingData";
            using(var settings=QueryOne(settingQuery,validate))
            using(var service=QueryOne("SELECT * FROM Msvm_VirtualSystemManagementService",validate))
            using(var keyboard=QueryOne(associated+"ResultClass=Msvm_Keyboard",validate))
            using(var mouse=QueryOne(associated+"ResultClass=Msvm_SyntheticMouse",validate))
            using(var video=QueryOne(associated+"ResultClass=Msvm_VideoHead",validate)){
                var result=new HyperVGuestIdentity(id,vm.Path.Path,settings.Path.Path,service.Path.Path,keyboard.Path.Path,mouse.Path.Path,video.Path.Path,
                    Convert.ToInt32(video["CurrentHorizontalResolution"],CultureInfo.InvariantCulture),Convert.ToInt32(video["CurrentVerticalResolution"],CultureInfo.InvariantCulture));
                result.Validate();validate();boundIdentity=result;return result;
            }
        }
    }
    ManagementBaseObject Invoke(string path,string method,Dictionary<string,object> arguments,Action validate){
        Connect(validate);
        using(var target=new ManagementObject(scope,new ManagementPath(path),null))
        using(var input=Around(validate,()=>target.GetMethodParameters(method))){
            foreach(var pair in arguments)input[pair.Key]=pair.Value;
            // Synchronous invocation is deliberate: cancellation never claims that
            // a provider call has drained before its actual return.
            validate();ManagementBaseObject output;
            try{output=HyperVInvocationBoundary.Call(()=>target.InvokeMethod(method,input,null));}
            catch(HyperVDrainUnconfirmedException error){error.Data["nativeCalls"]=new object[]{new HyperVNativeReceipt(method,null)};throw;}
            uint? nativeReturn=null;
            try{
                if(output==null)throw new HyperVDrainUnconfirmedException();
                try{nativeReturn=ReturnValue(output);}catch{throw new HyperVDrainUnconfirmedException();}
                // Inspect the native result before propagating cancellation: a
                // provider-started job is still executing outside this process.
                if(nativeReturn==4096)WaitForJob(output,validate);
                validate();return output;
            }
            catch(Exception error){
                if(nativeReturn.HasValue)error.Data["nativeCalls"]=new object[]{new HyperVNativeReceipt(method,nativeReturn.Value)};
                if(output!=null)output.Dispose();throw;
            }
        }
    }
    void WaitForJob(ManagementBaseObject output,Action validate){
        ManagementObject job;
        try{
            string path=null;
            foreach(PropertyData property in output.Properties)if(string.Equals(property.Name,"Job",StringComparison.OrdinalIgnoreCase))path=property.Value as string;
            if(string.IsNullOrEmpty(path))throw new HyperVDrainUnconfirmedException();
            var parsed=new ManagementPath(path);
            if(!string.Equals(parsed.ClassName,"Msvm_ConcreteJob",StringComparison.OrdinalIgnoreCase)
                ||(!string.IsNullOrEmpty(parsed.Server)&&parsed.Server!="."&&!string.Equals(parsed.Server,Environment.MachineName,StringComparison.OrdinalIgnoreCase))
                ||(!string.IsNullOrEmpty(parsed.NamespacePath)&&!string.Equals(parsed.NamespacePath,@"root\virtualization\v2",StringComparison.OrdinalIgnoreCase)))
                throw new HyperVDrainUnconfirmedException();
            job=new ManagementObject(scope,parsed,null);
        }catch{throw new HyperVDrainUnconfirmedException();}
        using(job){
            // Cancellation forbids new input, but this observation must continue
            // until the already-started provider job really reaches a terminal state.
            HyperVJobCompletion.Wait(()=>{
                job.Get();object state=job["JobState"],errorCode=job["ErrorCode"];
                if(state==null)throw new HyperVDrainUnconfirmedException();
                return new HyperVJobStatus(Convert.ToUInt16(state,CultureInfo.InvariantCulture),errorCode==null?(uint?)null:Convert.ToUInt32(errorCode,CultureInfo.InvariantCulture));
            },validate,()=>Thread.Sleep(50));
        }
    }
    static uint ReturnValue(ManagementBaseObject output){
        object value=output["ReturnValue"];if(value==null)throw new InvalidOperationException("hyperv-missing-result");return Convert.ToUInt32(value,CultureInfo.InvariantCulture);
    }
    public HyperVThumbnail Capture(HyperVGuestIdentity target,Action validate){
        target.Validate();
        using(var output=Invoke(target.ServicePath,"GetVirtualSystemThumbnailImage",new Dictionary<string,object>{{"TargetSystem",target.SettingsPath},{"WidthPixels",(ushort)target.Width},{"HeightPixels",(ushort)target.Height}},validate))
            return new HyperVThumbnail(output["ImageData"] as byte[],ReturnValue(output));
    }
    uint Input(HyperVGuestIdentity target,string path,string method,Dictionary<string,object> args,Action validate){
        target.Validate();using(var output=Invoke(path,method,args,validate))return ReturnValue(output);
    }
    public uint SetAbsolutePosition(HyperVGuestIdentity target,int x,int y,Action validate){return Input(target,target.MousePath,"SetAbsolutePosition",new Dictionary<string,object>{{"HorizontalPosition",x},{"VerticalPosition",y}},validate);}
    public uint ClickButton(HyperVGuestIdentity target,uint button,Action validate){return Input(target,target.MousePath,"ClickButton",new Dictionary<string,object>{{"ButtonIndex",button}},validate);}
    public uint TypeKey(HyperVGuestIdentity target,uint key,Action validate){return Input(target,target.KeyboardPath,"TypeKey",new Dictionary<string,object>{{"KeyCode",key}},validate);}
    public uint TypeText(HyperVGuestIdentity target,string text,Action validate){return Input(target,target.KeyboardPath,"TypeText",new Dictionary<string,object>{{"AsciiText",text}},validate);}
    public void Dispose(){}
}

public static class HyperVGuestWorker {
    [DllImport("kernel32.dll",SetLastError=true)]static extern SafeWaitHandle OpenProcess(uint access,bool inherit,uint processId);
    [DllImport("kernel32.dll",SetLastError=true)]static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe,out uint processId);
    sealed class ParentWait : WaitHandle {public ParentWait(SafeWaitHandle handle){SafeWaitHandle=handle;}}
    internal static void RunConnectedSession(Stream pipe,Action<TextReader,TextWriter> run){
        var reader=new StreamReader(pipe,new UTF8Encoding(false),false,4096,true);
        var writer=new StreamWriter(pipe,new UTF8Encoding(false),4096,true){AutoFlush=true};
        try{run(reader,TextWriter.Synchronized(writer));}
        finally{
            // Run(..., true) has already drained in its own finally, even if peer
            // closure raised an IOException. A redundant close/flush is not work.
            try{writer.Dispose();}catch(IOException){}catch(ObjectDisposedException){}
            try{reader.Dispose();}catch(IOException){}catch(ObjectDisposedException){}
        }
    }
    public static int Main(string[] args){
        string pipeName=null;uint parentId=0;
        string policyPath=null,policyHash=null;
        if(args==null||args.Length!=8)return 2;
        for(int i=0;i<args.Length;i+=2){
            if(args[i]=="--pipe"&&pipeName==null)pipeName=args[i+1];
            else if(args[i]=="--parent"&&parentId==0){if(!uint.TryParse(args[i+1],NumberStyles.None,CultureInfo.InvariantCulture,out parentId)||parentId==0)return 2;}
            else if(args[i]=="--policy"&&policyPath==null)policyPath=args[i+1];
            else if(args[i]=="--policy-sha256"&&policyHash==null)policyHash=args[i+1];
            else return 2;
        }
        if(pipeName==null||!Regex.IsMatch(pipeName,@"\A[A-Za-z0-9][A-Za-z0-9._-]{0,127}\z")||parentId==0)return 2;
        try { InstallationPolicy.InitializeVerified(policyPath,policyHash); InstallationPolicy.AssertWorkerIdentity(); }
        catch { return 5; }
        using(var parentHandle=OpenProcess(0x00100000,false,parentId)){
            if(parentHandle==null||parentHandle.IsInvalid)return 3;
            using(var parent=new ParentWait(parentHandle))
            using(var stop=new ManualResetEvent(false))
            using(var fatal=new ManualResetEvent(false))
            using(var pipe=new NamedPipeClientStream(".",pipeName,PipeDirection.InOut,PipeOptions.Asynchronous)){
                Thread watcher=null;bool verified=false;
                Action alive=()=>{if(parent.WaitOne(0))throw new InvalidOperationException("parent-exited");};
                try{
                    alive();pipe.Connect(30000);uint serverId;
                    if(!GetNamedPipeServerProcessId(pipe.SafePipeHandle,out serverId)||serverId!=parentId)throw new InvalidOperationException("worker-parent-mismatch");
                    alive();verified=true;
                    watcher=new Thread(()=>{int cause=WaitHandle.WaitAny(new WaitHandle[]{parent,stop,fatal});if(cause!=1){try{pipe.Dispose();}catch(ObjectDisposedException){}}});
                    watcher.IsBackground=true;watcher.Start();
                    RunConnectedSession(pipe,(reader,synchronized)=>{
                        using(var device=new HyperVManagementDevice()){
                            var surface=new HyperVWorkerSurface(device,new HyperVNativePixelEncoder(),null,alive,error=>{
                                try{synchronized.WriteLine(new JavaScriptSerializer().Serialize(new{type="worker-error",error}));synchronized.Flush();}catch(Exception){}
                                finally{fatal.Set();}
                            });
                            var identity=surface.Initialize(alive);
                            synchronized.WriteLine(new JavaScriptSerializer().Serialize(new{type="worker-ready",vmId=ConsoleProtocol.VmId,width=identity.Width,height=identity.Height}));
                            ConsoleProtocol.Run(reader,synchronized,surface,true);
                        }
                    });
                    return fatal.WaitOne(0)?4:0;
                }catch(Exception error){
                    if(verified&&pipe.IsConnected){
                        try{
                            // A fixed code and HRESULT are sufficient; never expose WMI
                            // query text, process details, credentials, or input content.
                            var line=new JavaScriptSerializer().Serialize(new{type="worker-error",error="hyperv-worker-failed",hresult="0x"+unchecked((uint)error.HResult).ToString("X8")});
                            byte[] bytes=new UTF8Encoding(false).GetBytes(line+"\n");pipe.Write(bytes,0,bytes.Length);pipe.Flush();
                        }catch(Exception){}
                    }
                    return 4;
                }finally{stop.Set();if(watcher!=null)watcher.Join();}
            }
        }
    }
}
