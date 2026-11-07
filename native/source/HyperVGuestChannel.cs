using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

public interface IHyperVGuestChannel {
    object Execute(string action,Dictionary<string,object> args,DateTime deadline,string source,long epoch,Action validate);
}

public sealed class HyperVGuestChannel : IHyperVGuestChannel {
    readonly object lifecycle=new object(),writes=new object(),drainSync=new object();
    readonly InputDebugLog log;
    readonly ManualResetEventSlim launchFinished=new ManualResetEventSlim(false);
    NamedPipeServerStream pipe;TextReader reader;TextWriter writer;Process worker;
    bool starting,stopping,drained;Exception drainFailure;int busy;
    public event Action Unavailable;
    public bool IsBusy {get{return Interlocked.CompareExchange(ref busy,0,0)!=0;}}
    [DllImport("kernel32.dll",SetLastError=true)]
    [return:MarshalAs(UnmanagedType.Bool)]static extern bool GetNamedPipeClientProcessId(Microsoft.Win32.SafeHandles.SafePipeHandle handle,out uint pid);
    static JavaScriptSerializer Json(){return new JavaScriptSerializer{MaxJsonLength=5*1024*1024};}
    public HyperVGuestChannel(InputDebugLog log){this.log=log;}
    internal HyperVGuestChannel(InputDebugLog log,TextReader reader,TextWriter writer){this.log=log;this.reader=reader;this.writer=writer;}
    public void Start(){
        lock(lifecycle){if(stopping)throw new InvalidOperationException("worker-stopped");if(starting)throw new InvalidOperationException("worker-already-started");starting=true;}
        try{
            string name="VmGuest-"+Guid.NewGuid().ToString("N");
            var security=new PipeSecurity();security.SetAccessRuleProtection(true,false);
            security.AddAccessRule(new PipeAccessRule(WindowsIdentity.GetCurrent().User,PipeAccessRights.FullControl,AccessControlType.Allow));
            var server=new NamedPipeServerStream(name,PipeDirection.InOut,1,PipeTransmissionMode.Byte,PipeOptions.Asynchronous,4096,4096,security);
            lock(lifecycle){if(stopping){server.Dispose();throw new InvalidOperationException("worker-stopped");}pipe=server;}
            var info=new ProcessStartInfo(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"GuestWorker.exe"),"--pipe "+name+" --parent "+Process.GetCurrentProcess().Id+" --policy \""+InstallationPolicy.Current.Path+"\" --policy-sha256 "+InstallationPolicy.Current.Sha256){UseShellExecute=true,Verb="runas",WindowStyle=ProcessWindowStyle.Hidden};
            var launched=Process.Start(info);lock(lifecycle){worker=launched;if(stopping)server.Dispose();}
            if(launched==null)throw new InvalidOperationException("worker-start-failed");
            var connected=server.BeginWaitForConnection(null,null);
            if(!connected.AsyncWaitHandle.WaitOne(30000)){server.Dispose();throw new InvalidOperationException("worker-connect-timeout");}
            server.EndWaitForConnection(connected);
            uint pid;if(!GetNamedPipeClientProcessId(server.SafePipeHandle,out pid)||pid!=launched.Id)throw new InvalidOperationException("worker-process-mismatch");
            reader=new StreamReader(server,new UTF8Encoding(false),false,4096,true);
            writer=new StreamWriter(server,new UTF8Encoding(false),4096,true){AutoFlush=true};
            var hello=reader.ReadLineAsync();if(!hello.Wait(30000))throw new InvalidOperationException("worker-ready-timeout");
            var ready=Json().Deserialize<Dictionary<string,object>>(hello.Result??"null");
            if(ready!=null&&ready.ContainsKey("type")&&Convert.ToString(ready["type"])=="worker-error"){
                if(log!=null)log.Add("manual","后台初始化",Json().Serialize(ready));
                throw new InvalidOperationException("worker-initialization-failed");
            }
            if(ready==null||!ready.ContainsKey("type")||Convert.ToString(ready["type"])!="worker-ready"||!ready.ContainsKey("vmId")||Convert.ToString(ready["vmId"])!=ConsoleProtocol.VmId)
                throw new InvalidOperationException("worker-not-ready");
            lock(lifecycle){if(stopping)throw new InvalidOperationException("worker-stopped");}
        }catch{RequestStop();throw;}
        finally{launchFinished.Set();}
    }
    void Send(object message){lock(writes){if(writer==null)throw new InvalidOperationException("worker-unavailable");writer.WriteLine(Json().Serialize(message));}}
    public object Execute(string action,Dictionary<string,object> args,DateTime deadline,string source,long epoch,Action validate){
        if(Interlocked.CompareExchange(ref busy,1,0)!=0)throw new InvalidOperationException("request-busy");
        try{
            lock(lifecycle){if(stopping||writer==null)throw new InvalidOperationException("worker-unavailable");}
            validate();if(DateTime.UtcNow>deadline)throw new InvalidOperationException("request-expired");
            string id=Guid.NewGuid().ToString("N");
            if(log!=null)log.Add(source,"实际发送","Hyper-V "+action+" · 已绑定虚拟机");
            Send(new{id,vmId=ConsoleProtocol.VmId,source,controlEpoch=epoch,action,args,expiresAtUtcMs=(long)(deadline-new DateTime(1970,1,1,0,0,0,DateTimeKind.Utc)).TotalMilliseconds});
            var response=reader.ReadLineAsync();Exception cancelled=null;bool cancelSent=false;
            while(!response.IsCompleted){
                if(cancelled==null){try{validate();if(DateTime.UtcNow>deadline)throw new InvalidOperationException("request-expired");}catch(Exception error){cancelled=error;}}
                if(cancelled!=null&&!cancelSent){Send(new{type="cancel-request",id,vmId=ConsoleProtocol.VmId,source,controlEpoch=epoch});cancelSent=true;if(log!=null)log.Add(source,"取消","等待已经开始的 Hyper-V 调用返回");}
                try{response.Wait(25);}catch(AggregateException){break;}
            }
            string line;
            try{line=response.GetAwaiter().GetResult();}catch(Exception error){throw new InvalidOperationException("execution-drain-unconfirmed",error);}
            if(line==null)throw new InvalidOperationException("execution-drain-unconfirmed");
            Dictionary<string,object> reply;
            try{reply=Json().Deserialize<Dictionary<string,object>>(line);}catch(Exception error){throw new InvalidOperationException("execution-drain-unconfirmed",error);}
            if(reply==null||!reply.ContainsKey("id")||Convert.ToString(reply["id"])!=id)throw new InvalidOperationException("execution-drain-unconfirmed");
            if(log!=null)log.Add(source,"发送层结果","Hyper-V 请求已返回 · "+(reply.ContainsKey("ok")&&object.Equals(reply["ok"],true)?"完成":"失败"));
            object resultObject,calls;var result=reply.TryGetValue("result",out resultObject)?resultObject as Dictionary<string,object>:null;
            if(log!=null&&result!=null&&result.TryGetValue("nativeCalls",out calls))log.Add(source,"调用回执",Json().Serialize(calls));
            if(log!=null&&reply.TryGetValue("nativeCalls",out calls)&&calls!=null)log.Add(source,"调用回执",Json().Serialize(calls));
            if(!reply.ContainsKey("ok")||!(reply["ok"] is bool)||reply.ContainsKey("error")&&Convert.ToString(reply["error"])=="execution-drain-unconfirmed")
                throw new InvalidOperationException("execution-drain-unconfirmed");
            if(cancelled!=null)throw cancelled;
            validate();if(DateTime.UtcNow>deadline)throw new InvalidOperationException("request-expired");
            if(!reply.ContainsKey("ok")||!object.Equals(reply["ok"],true))throw new InvalidOperationException(reply.ContainsKey("error")?Convert.ToString(reply["error"]):"worker-request-failed");
            return reply.ContainsKey("result")?reply["result"]:null;
        }catch(IOException error){RequestStop();throw new InvalidOperationException("execution-drain-unconfirmed",error);}
        catch(ObjectDisposedException error){RequestStop();throw new InvalidOperationException("execution-drain-unconfirmed",error);}
        catch(InvalidOperationException error){if(error.Message=="execution-drain-unconfirmed")RequestStop();throw;}
        finally{Interlocked.Exchange(ref busy,0);}
    }
    public void RequestStop(){bool notify;lock(lifecycle){notify=!stopping;stopping=true;try{if(pipe!=null)pipe.Dispose();}catch(IOException){}}
        if(notify&&Unavailable!=null)try{Unavailable();}catch(Exception){}
    }
    public void StopAndDrain(){
        RequestStop();lock(drainSync){
            if(drained){if(drainFailure!=null)throw drainFailure;return;}
            bool launched;lock(lifecycle){launched=starting;}
            if(launched)launchFinished.Wait();
            Process process;lock(lifecycle){process=worker;}
            // No kill/timeout shortcut: a WMI method already entered must return.
            if(process!=null){process.WaitForExit();int exitCode=process.ExitCode;process.Dispose();if(exitCode!=0)drainFailure=new InvalidOperationException("worker-drain-unconfirmed");}
            drained=true;
            if(drainFailure!=null)throw drainFailure;
        }
    }
}
