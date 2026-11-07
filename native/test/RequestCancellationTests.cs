using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
static class RequestCancellationTests {
    sealed class Input : TextReader {
        readonly BlockingCollection<string> lines=new BlockingCollection<string>(32);
        public void Send(string line){lines.Add(line);}
        public void End(){lines.CompleteAdding();}
        public override string ReadLine(){try{return lines.Take();}catch(InvalidOperationException){return null;}}
    }
    sealed class Output : StringWriter {
        public readonly BlockingCollection<string> Lines=new BlockingCollection<string>();
        public override void WriteLine(string line){Lines.Add(line);}
        public Dictionary<string,object> Take(){
            string line;if(!Lines.TryTake(out line,1500))throw new Exception("response not received");
            return new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(line);
        }
    }
    sealed class Surface : IConsoleSurface,IAttributedConsoleSurface,ICancellableConsoleSurface {
        public readonly ManualResetEventSlim Entered=new ManualResetEventSlim(),Release=new ManualResetEventSlim(),Cancelled=new ManualResetEventSlim(),Completed=new ManualResetEventSlim(),Drain=new ManualResetEventSlim(true);
        public int Calls;
        public object ExecuteCancellable(string action,Dictionary<string,object> args,DateTime deadline,string source,long epoch,Action validateCancellation){
            Interlocked.Increment(ref Calls);Entered.Set();
            try{
                while(!Release.Wait(1))validateCancellation();
                validateCancellation();return new{accepted=true};
            }catch(InvalidOperationException error){if(error.Message=="request-cancelled"){Cancelled.Set();Drain.Wait();}throw;}
            finally{Completed.Set();}
        }
        public object Capture(){throw new Exception("unscoped fallback used");}
        public object Perform(string action,Dictionary<string,object> args){throw new Exception("unscoped fallback used");}
        public object ExecuteForSource(string action,Dictionary<string,object> args,DateTime deadline,string source,long epoch){throw new Exception("uncancellable fallback used");}
    }
    sealed class Session : IDisposable {
        public readonly Input Input=new Input();public readonly Output Output=new Output();public readonly Surface Surface=new Surface();
        readonly Task run;
        public Session(){run=Task.Factory.StartNew(()=>ConsoleProtocol.Run(Input,Output,Surface));}
        public void Begin(string id){Input.Send(Request(id));if(!Surface.Entered.Wait(1500))throw new Exception("request worker did not enter");}
        public void Eof(){Input.End();if(!run.Wait(1500))throw new Exception("reader did not stop at EOF");}
        public void Dispose(){Surface.Release.Set();Surface.Drain.Set();Input.End();if(!run.Wait(1500))throw new Exception("test reader leaked");}
    }
    static string Request(string id){return new JavaScriptSerializer().Serialize(new{id,vmId=ConsoleProtocol.VmId,source="codex",controlEpoch=7,action="type_text",args=new{text="abc"},expiresAtUtcMs=(long)(DateTime.UtcNow.AddSeconds(5)-new DateTime(1970,1,1,0,0,0,DateTimeKind.Utc)).TotalMilliseconds});}
    static string Cancel(string id,string source="codex",int epoch=7,string vm=null){return new JavaScriptSerializer().Serialize(new{type="cancel-request",id,vmId=vm??ConsoleProtocol.VmId,source,controlEpoch=epoch});}
    static void Reply(Dictionary<string,object> reply,string id,bool ok,string error=null){
        if((string)reply["id"]!=id||(bool)reply["ok"]!=ok||error!=null&&(string)reply["error"]!=error)
            throw new Exception("unexpected reply: "+new JavaScriptSerializer().Serialize(reply));
    }
    static int Main(){try{
        using(var session=new Session()){
            session.Surface.Drain.Reset();session.Begin("first");session.Input.Send(Cancel("first"));
            if(!session.Surface.Cancelled.Wait(1500))throw new Exception("cancel did not reach active surface");
            string premature;
            if(session.Output.Lines.TryTake(out premature,100))throw new Exception("cancel replied before surface drained");
            session.Surface.Drain.Set();
            Reply(session.Output.Take(),"first",false,"request-cancelled");
            if(!session.Surface.Cancelled.IsSet||!session.Surface.Completed.IsSet)throw new Exception("cancel receipt preceded execution drain");
        }
        using(var session=new Session()){
            session.Begin("first");
            session.Input.Send(Cancel("other"));session.Input.Send(Cancel("first","agent"));session.Input.Send(Cancel("first",epoch:8));
            session.Input.Send(Cancel("first",vm:"22222222-2222-4222-8222-222222222222"));
            session.Input.Send(Cancel("first").TrimEnd('}')+",\"extra\":true}");
            session.Input.Send(Request("busy-marker"));Reply(session.Output.Take(),"busy-marker",false,"request-busy");
            if(session.Surface.Cancelled.IsSet||session.Surface.Calls!=1)throw new Exception("unmatched cancel or busy request reached surface");
            session.Input.Send(Cancel("first"));Reply(session.Output.Take(),"first",false,"request-cancelled");
        }
        using(var session=new Session()){
            session.Begin("eof");session.Eof();
            if(!session.Surface.Cancelled.Wait(1500)||!session.Surface.Completed.Wait(1500))throw new Exception("EOF did not cancel active execution");
        }
        using(var session=new Session()){
            session.Begin("old");session.Surface.Release.Set();Reply(session.Output.Take(),"old",true);
            session.Surface.Release.Reset();session.Surface.Entered.Reset();session.Surface.Completed.Reset();
            session.Begin("new");session.Input.Send(Cancel("old"));session.Input.Send(Request("late-marker"));
            Reply(session.Output.Take(),"late-marker",false,"request-busy");
            if(session.Surface.Cancelled.IsSet||session.Surface.Calls!=2)throw new Exception("old cancellation affected new request");
            session.Input.Send(Cancel("new"));Reply(session.Output.Take(),"new",false,"request-cancelled");
        }
        Console.WriteLine("Cancellation reached the active execution, matched identity, rejected overlap and drained; no COM, UI or guest");return 0;
    }catch(Exception error){Console.Error.WriteLine(error);return 1;}}
}
