// Owned-stdio message protocol; never creates or authorizes an RDP surface.
using System;
using System.Collections.Generic;
using System.IO;
using System.Threading;
using System.Web.Script.Serialization;

public interface IConsoleSurface {
    object Capture();
    object Perform(string action, Dictionary<string,object> args);
}
public interface IScopedConsoleSurface {
    object Execute(string action,Dictionary<string,object> args,DateTime deadline);
}
public interface IAttributedConsoleSurface {
    object ExecuteForSource(string action,Dictionary<string,object> args,DateTime deadline,string source,long controlEpoch);
}
public interface ICancellableConsoleSurface {
    object ExecuteCancellable(string action,Dictionary<string,object> args,DateTime deadline,string source,long controlEpoch,Action validateCancellation);
}
public sealed class ControlOwnership {
    readonly object sync=new object();string source="manual";long epoch;
    public string Source {get{lock(sync)return source;}}
    public long Epoch {get{lock(sync)return epoch;}}
    // The source is an activity label, never a permission selection. Epoch is
    // only a cancellation boundary; changing the label leaves it unchanged.
    public void SetActivity(string value){
        if(value!="manual"&&value!="codex"&&value!="agent")throw new InvalidOperationException("invalid-control-source");
        lock(sync){source=value;}
    }
    public void Cancel(){lock(sync){checked{epoch++;}source="manual";}}
    public void Validate(string value,long expected){lock(sync){
        if(expected!=epoch)throw new InvalidOperationException("control-epoch-revoked");
        if(value!="codex"&&value!="agent")throw new InvalidOperationException("invalid-control-source");
    }}
}
public static class RequestDeadline {
    public static object Run(DateTime deadline,Func<object> execute){
        if(DateTime.UtcNow>deadline)throw new InvalidOperationException("request-expired");
        object result=execute();
        if(DateTime.UtcNow>deadline)throw new InvalidOperationException("request-expired");
        return result;
    }
}

public static class ConsoleProtocol {
    public static string VmId { get { return InstallationPolicy.Current.VmId; } }
    static JavaScriptSerializer NewJson(){return new JavaScriptSerializer { MaxJsonLength = 5 * 1024 * 1024 };}

    static bool Exact(Dictionary<string,object> data, params string[] names) {
        if (data == null || data.Count != names.Length) return false;
        foreach (string name in names) if (!data.ContainsKey(name)) return false;
        return true;
    }

    static bool Valid(string action, Dictionary<string,object> args) {
        if (action == "capture") return Exact(args);
        if (action == "click") {
            if (!Exact(args, "x", "y", "button") || !(args["x"] is int) || !(args["y"] is int)) return false;
            int x=(int)args["x"], y=(int)args["y"];
            string button=args["button"] as string;
            return x >= 0 && y >= 0 && (button == "left" || button == "right");
        }
        if (action == "key") {
            string key;
            if (!Exact(args, "key") || (key=args["key"] as string) == null) return false;
            return Array.IndexOf(new[]{"Shift","Space","Enter","Escape","Tab","Backspace","ArrowUp","ArrowDown","ArrowLeft","ArrowRight"}, key) >= 0;
        }
        if (action == "type_text") {
            string text;
            return Exact(args, "text") && (text=args["text"] as string) != null && text.Length > 0 && text.Length <= 1000;
        }
        return false;
    }

    public static string ProcessLine(string line, IConsoleSurface surface) {
        return ProcessLine(line,surface,()=>{});
    }
    static string Reply(IConsoleSurface surface,string source,object response){
        var trace=InputDebugLog.Of(surface);if(trace!=null)trace.Reply(source,response);
        return NewJson().Serialize(response);
    }
    static string ProcessLine(string line,IConsoleSurface surface,Action validateCancellation){
        string id = null,source=null;
        var Json=NewJson();
        try {
            var request = Json.Deserialize<Dictionary<string,object>>(line);
            source=request!=null&&request.ContainsKey("source")?request["source"] as string:null;
            var trace=InputDebugLog.Of(surface);if(trace!=null)trace.Request(request);
            if (request == null || !(request.ContainsKey("id") && (id=request["id"] as string) != null && id.Length > 0 && id.Length <= 80))
                return Reply(surface,source,new { id, ok=false, error="invalid-request" });
            if (!request.ContainsKey("vmId") || (request["vmId"] as string) != VmId)
                return Reply(surface,source,new { id, ok=false, error="target-mismatch" });
            if(source!="codex"&&source!="agent")return Reply(surface,source,new{id,ok=false,error="invalid-control-source"});
            object rawEpoch=request.ContainsKey("controlEpoch")?request["controlEpoch"]:null;
            if((!(rawEpoch is long)&&!(rawEpoch is int))||Convert.ToInt64(rawEpoch)<0)
                return Reply(surface,source,new{id,ok=false,error="invalid-control-epoch"});
            long controlEpoch=Convert.ToInt64(rawEpoch);
            var action = request.ContainsKey("action") ? request["action"] as string : null;
            var args = request.ContainsKey("args") ? request["args"] as Dictionary<string,object> : null;
            if (!Valid(action, args)) return Reply(surface,source,new { id, ok=false, error="invalid-action" });
            if (surface == null) return Reply(surface,source,new { id, ok=false, error="surface-unavailable" });
            DateTime deadline=DateTime.MaxValue;
            if(request.ContainsKey("expiresAtUtcMs")){
                object raw=request["expiresAtUtcMs"];
                if(!(raw is long)&&!(raw is int))return Reply(surface,source,new{id,ok=false,error="invalid-deadline"});
                deadline=new DateTime(1970,1,1,0,0,0,DateTimeKind.Utc).AddMilliseconds(Convert.ToInt64(raw));
                if(deadline>DateTime.UtcNow.AddSeconds(10))return Reply(surface,source,new{id,ok=false,error="invalid-deadline"});
            }
            var scoped=surface as IScopedConsoleSurface;
            var attributed=surface as IAttributedConsoleSurface;
            var cancellable=surface as ICancellableConsoleSurface;
            validateCancellation();
            var result = RequestDeadline.Run(deadline,()=>cancellable!=null?cancellable.ExecuteCancellable(action,args,deadline,source,controlEpoch,validateCancellation):
                attributed!=null?attributed.ExecuteForSource(action,args,deadline,source,controlEpoch):
                scoped!=null?scoped.Execute(action,args,deadline):
                action == "capture" ? surface.Capture() : surface.Perform(action, args));
            validateCancellation();
            return Reply(surface,source,new { id, ok=true, result });
        } catch (Exception e) {
            while(e is System.Reflection.TargetInvocationException&&e.InnerException!=null)e=e.InnerException;
            string detail=e is InvalidOperationException&&System.Text.RegularExpressions.Regex.IsMatch(e.Message,"^[A-Za-z0-9_:.-]{1,100}$")?e.Message:"request-failed";
            return Reply(surface,source,new { id, ok=false, error=detail,hresult="0x"+unchecked((uint)e.HResult).ToString("X8"),nativeCalls=e.Data.Contains("nativeCalls")?e.Data["nativeCalls"]:null });
        }
    }

    sealed class RequestScope {
        public readonly string Id,Source;public readonly long Epoch;public readonly bool Matchable;
        int cancelled;
        public RequestScope(Dictionary<string,object> request){Matchable=Identity(request,out Id,out Source,out Epoch);}
        public void Cancel(){Interlocked.Exchange(ref cancelled,1);}
        public void Validate(){if(Interlocked.CompareExchange(ref cancelled,0,0)!=0)throw new InvalidOperationException("request-cancelled");}
        public bool Matches(Dictionary<string,object> message){
            string id,source;long epoch;
            return Matchable&&Identity(message,out id,out source,out epoch)&&Id==id&&Source==source&&Epoch==epoch;
        }
    }
    static bool Identity(Dictionary<string,object> message,out string id,out string source,out long epoch){
        id=null;source=null;epoch=-1;
        if(message==null||!message.ContainsKey("id")||(id=message["id"] as string)==null||id.Length<1||id.Length>80
            ||!message.ContainsKey("vmId")||(message["vmId"] as string)!=VmId
            ||!message.ContainsKey("source")||((source=message["source"] as string)!="codex"&&source!="agent")
            ||!message.ContainsKey("controlEpoch"))return false;
        object raw=message["controlEpoch"];
        if(!(raw is int)&&!(raw is long))return false;
        epoch=Convert.ToInt64(raw);return epoch>=0;
    }
    public static void Run(TextReader input, TextWriter output, IConsoleSurface surface) {
        Run(input,output,surface,false);
    }
    public static void Run(TextReader input, TextWriter output, IConsoleSurface surface,bool waitForDrain) {
        // The reader must remain available while WGC or a text batch runs.
        // There is exactly one execution slot and no pending-work queue.
        object sync=new object(),outputSync=new object();RequestScope active=null;bool ended=false;
        var drained=new ManualResetEventSlim(true);
        Action<string> respond=reply=>{
            lock(outputSync){
                lock(sync){if(ended)return;}
                output.WriteLine(reply);output.Flush();
            }
        };
        try{
          string line;
          while((line=input.ReadLine())!=null){
            Dictionary<string,object> message=null;
            try{message=NewJson().Deserialize<Dictionary<string,object>>(line);}catch(Exception){}
            // Typed control messages can never fall through into an action,
            // including malformed/unknown controls carrying an action field.
            if(message!=null&&message.ContainsKey("type")){
                // Host-only diagnostics use a typed, read-only control message.
                // They never enter the action slot or the guest worker channel.
                if(Exact(message,"type","id","vmId")&&(message["type"] as string)=="debug-snapshot"
                    &&message["id"] is string&&((string)message["id"]).Length>0&&((string)message["id"]).Length<=80
                    &&(message["vmId"] as string)==VmId){
                    var debug=InputDebugLog.Of(surface);
                    if(debug!=null){
                        long revision;var rows=debug.Snapshot(out revision);
                        respond(NewJson().Serialize(new{type="debug-snapshot",id=message["id"],vmId=VmId,
                            enabled=debug.Enabled,capacity=InputDebugLog.Capacity,revision,rows}));
                    }
                    continue;
                }
                bool applied=false;
                if(Exact(message,"type","id","vmId","source","controlEpoch")&&(message["type"] as string)=="cancel-request")
                    lock(sync){if(active!=null&&active.Matches(message)){active.Cancel();applied=true;}}
                var trace=InputDebugLog.Of(surface);if(trace!=null)trace.Add(message.ContainsKey("source")?message["source"] as string:null,"控制请求",Convert.ToString(message["type"])+(applied?" · 已取消对应请求":" · 未匹配，未执行"));
                continue;
            }
            var scope=new RequestScope(message);bool busy;
            lock(sync){if(ended)break;busy=active!=null;if(!busy){active=scope;drained.Reset();}}
            if(busy){var trace=InputDebugLog.Of(surface);if(trace!=null)trace.Request(message);respond(Reply(surface,scope.Source,new{id=scope.Id,ok=false,error="request-busy"}));continue;}
            string requestLine=line;
            try{
                bool queued=ThreadPool.QueueUserWorkItem(_=>{
                    try{
                        string reply=ProcessLine(requestLine,surface,scope.Validate);
                        // The operation (including cancellation) is fully out of
                        // the surface before another request can enter its slot.
                        lock(sync){if(object.ReferenceEquals(active,scope))active=null;drained.Set();}
                        respond(reply);
                    }catch(Exception){
                        lock(sync){ended=true;scope.Cancel();if(active!=null)active.Cancel();drained.Set();}
                    }
                });
                if(!queued)throw new InvalidOperationException("request-worker-unavailable");
            }catch(Exception){
                scope.Cancel();lock(sync){if(object.ReferenceEquals(active,scope))active=null;drained.Set();}
                respond(Reply(surface,scope.Source,new{id=scope.Id,ok=false,error="request-worker-unavailable"}));
            }
          }
        }finally{
            // EOF revokes execution immediately. Do not wait here before the
            // owning window can run its normal close/disconnect path.
            lock(sync){ended=true;if(active!=null)active.Cancel();}
            // The privileged worker must stay alive until a started WMI call
            // returns. EOF cancels future calls, not an already-running method.
            if(waitForDrain)drained.Wait();
        }
    }
}
