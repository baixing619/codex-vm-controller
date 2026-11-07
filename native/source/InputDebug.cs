using System;
using System.Collections.Generic;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;


// Opt-in, memory-only diagnostics. Nothing here writes files, stdout or a socket.
public interface IInputDebugSurface { InputDebugLog InputDebug { get; } }
public sealed class InputDebugLog {
    readonly object sync=new object();
    readonly Queue<string> rows=new Queue<string>();
    public const int Capacity=256;
    bool enabled;long revision;
    public event Action Changed;
    public bool Enabled {get{lock(sync)return enabled;}}
    public void SetEnabled(bool value){lock(sync){enabled=value;rows.Clear();revision++;}Notify();}
    public string[] Snapshot(out long version){lock(sync){version=revision;return rows.ToArray();}}
    public void Add(string source,string stage,string detail){
        lock(sync){
            if(!enabled)return;
            rows.Enqueue(DateTime.Now.ToString("HH:mm:ss.fff")+"  "+Who(source)+"  ["+stage+"] "+Clean(detail));
            while(rows.Count>Capacity)rows.Dequeue();revision++;
        }
        Notify();
    }
    void Notify(){var changed=Changed;if(changed!=null)try{changed();}catch(Exception){} }
    static string Clean(string text){text=(text??"").Replace("\r","\\r").Replace("\n","\\n").Replace("\t","\\t");return text.Length<=4096?text:text.Substring(0,4096)+"…";}
    public static string Who(string source){return source=="agent"?"Agent":source=="codex"?"Codex":source=="manual"?"控制台直接输入":"未标明来源";}
    public static InputDebugLog Of(IConsoleSurface surface){var traced=surface as IInputDebugSurface;return traced==null?null:traced.InputDebug;}
    static string Field(Dictionary<string,object> data,string key){object value;return data!=null&&data.TryGetValue(key,out value)?Convert.ToString(value):"?";}
    public void Request(Dictionary<string,object> request){
        if(!Enabled)return;
        string source=Field(request,"source"),action=Field(request,"action");
        object raw;var args=request!=null&&request.TryGetValue("args",out raw)?raw as Dictionary<string,object>:null;
        string detail=action;
        if(action=="click")detail+=" ("+Field(args,"x")+","+Field(args,"y")+") "+Field(args,"button");
        if(action=="key")detail+=" "+Field(args,"key");
        if(action=="type_text")detail+=" \""+Field(args,"text")+"\"";
        Add(source,"请求",detail+"  id="+Field(request,"id"));
    }
    public void Reply(string source,object response){
        if(!Enabled||response==null)return;
        var type=response.GetType();var ok=type.GetProperty("ok");
        bool success=ok!=null&&object.Equals(ok.GetValue(response,null),true);
        var error=type.GetProperty("error");var id=type.GetProperty("id");
        Add(source,"结果",(success?"适配器完成；客机画面效果需截图确认": "拒绝/失败："+(error==null?"unknown":Convert.ToString(error.GetValue(response,null))))
            +"  id="+(id==null?"?":Convert.ToString(id.GetValue(response,null))));
    }
}

// Carries attribution only on the executing UI thread, including synchronous
// window messages nested inside a send. It grants no control or permission.
public sealed class InputTrace : IDisposable {
    [ThreadStatic]static InputTrace current;
    readonly InputTrace previous;readonly InputDebugLog log;readonly string source;
    public InputTrace(InputDebugLog log,string source){previous=current;this.log=log;this.source=source;current=this;}
    public void Dispose(){current=previous;}
    public static bool IsRequest {get{return current!=null&&(current.source=="codex"||current.source=="agent");}}
    public static void Write(string stage,string detail){if(current!=null&&current.log!=null)current.log.Add(current.source,stage,detail);}
    public static void Window(InputDebugLog log,string detail,string activeSource=null){
        string source=current!=null?current.source:activeSource;
        bool active=source=="codex"||source=="agent";
        if(log!=null)log.Add(active?source:"manual",current!=null?"控件收到 · RPC":active?"控件收到 · 活跃请求期间":"控件收到 · 直接输入",detail);
    }
}

