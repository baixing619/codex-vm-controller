// Guest-only stdio owner. No Form, RDP control, HWND or message loop is created.
using System;
using System.Collections.Generic;
using System.IO;
using System.Threading;
using System.Web.Script.Serialization;

public sealed class BackgroundProtocol : IConsoleSurface,IAttributedConsoleSurface,ICancellableConsoleSurface,IInputDebugSurface {
    readonly object sync=new object();
    readonly IHyperVGuestChannel guest;
    readonly TextWriter output;
    readonly ControlOwnership ownership=new ControlOwnership();
    bool connected,unavailable;int running,outputFailed;
    public InputDebugLog InputDebug {get;private set;}

    public BackgroundProtocol(IHyperVGuestChannel guest,TextWriter output)
        : this(guest,output,new InputDebugLog()) { }
    BackgroundProtocol(IHyperVGuestChannel guest,TextWriter output,InputDebugLog debug){
        if(guest==null)throw new ArgumentNullException("guest");
        if(output==null)throw new ArgumentNullException("output");
        this.guest=guest;this.output=TextWriter.Synchronized(output);InputDebug=debug;
        InputDebug.SetEnabled(true);
    }

    public static int Run(TextReader input,TextWriter output){
        var debug=new InputDebugLog();
        var channel=new HyperVGuestChannel(debug);
        var session=new BackgroundProtocol(channel,output,debug);
        channel.Unavailable+=session.Disconnect;
        try{return session.RunSession(input,channel.Start,channel.StopAndDrain);}
        finally{channel.Unavailable-=session.Disconnect;}
    }

    // Lifecycle callbacks belong to this owner. They also allow a controlled
    // transport to exercise the real protocol without invoking UAC or WMI.
    public int RunSession(TextReader input,Action start,Action stopAndDrain){
        if(input==null||start==null||stopAndDrain==null)throw new ArgumentNullException("background-lifecycle");
        if(Interlocked.Exchange(ref running,1)!=0)throw new InvalidOperationException("background-already-started");
        int outcome=0;
        try{
            lock(sync)PublishLocked(); // Startup is explicitly unavailable.
            start(); // Native Start returns only after a verified worker-ready.
            lock(sync){
                if(unavailable)throw new InvalidOperationException("worker-unavailable");
                connected=true;PublishLocked();
            }
            // EOF revokes the request immediately and waits for its native call
            // to return before the owner's worker is closed. It never stops VM.
            ConsoleProtocol.Run(input,output,this,true);
        }catch(Exception error){
            outcome=1;InputDebug.Add("manual","后台错误",error.GetType().Name);
        }finally{
            Disconnect();
            try{stopAndDrain();}
            catch(Exception error){outcome=1;InputDebug.Add("manual","后台排空",error.GetType().Name);}
        }
        return Interlocked.CompareExchange(ref outputFailed,0,0)!=0?1:outcome;
    }

    void PublishLocked(){
        try{
            output.WriteLine(new JavaScriptSerializer().Serialize(new{type="control-state",
                source=connected?ownership.Source:"manual",controlEpoch=connected?(long?)ownership.Epoch:null}));
            output.Flush();
        }catch(Exception){
            connected=false;unavailable=true;ownership.Cancel();Interlocked.Exchange(ref outputFailed,1);
            throw new InvalidOperationException("protocol-output-unavailable");
        }
    }
    public void Disconnect(){
        lock(sync){
            if(unavailable)return;
            connected=false;unavailable=true;ownership.Cancel();
            try{PublishLocked();}catch(InvalidOperationException){}
        }
    }
    void SetActivity(string source){
        lock(sync){
            if(!connected||unavailable){if(source=="manual")return;throw new InvalidOperationException("worker-unavailable");}
            ownership.SetActivity(source);PublishLocked();
        }
    }
    public object ExecuteForSource(string action,Dictionary<string,object> args,DateTime deadline,string source,long controlEpoch){
        return ExecuteCancellable(action,args,deadline,source,controlEpoch,()=>{});
    }
    public object ExecuteCancellable(string action,Dictionary<string,object> args,DateTime deadline,string source,long controlEpoch,Action validateCancellation){
        if(deadline==DateTime.MaxValue)throw new InvalidOperationException("request-deadline-required");
        Action validate=()=>{
            validateCancellation();
            lock(sync){
                if(!connected||unavailable)throw new InvalidOperationException("worker-unavailable");
                ownership.Validate(source,controlEpoch);
            }
        };
        validate();SetActivity(source);
        try{return RequestDeadline.Run(deadline,()=>{
            validate();var result=guest.Execute(action,args,deadline,source,controlEpoch,validate);validate();return result;
        });}
        finally{SetActivity("manual");}
    }
    public object Capture(){throw new InvalidOperationException("request-scope-required");}
    public object Perform(string action,Dictionary<string,object> args){throw new InvalidOperationException("request-scope-required");}
}
