using System;
using System.IO;
using System.Collections.Generic;
using System.Web.Script.Serialization;
static class BackgroundLifecycleTests {
 sealed class Fake : IHyperVGuestChannel {
  public object Execute(string a,Dictionary<string,object> b,DateTime deadline,string source,long epoch,Action validate){validate();return null;}
 }
 static int Main(){try{
  var output=new StringWriter();var session=new BackgroundProtocol(new Fake(),output);bool started=false,stopped=false;
  int code=session.RunSession(new StringReader(""),()=>{started=true;},()=>{stopped=true;});
  if(code!=0||!started||!stopped)throw new Exception("lifecycle not completed");
  var lines=output.ToString().Split(new[]{'\r','\n'},StringSplitOptions.RemoveEmptyEntries);
  if(lines.Length<3)throw new Exception("state sequence missing");
  var json=new JavaScriptSerializer();
  var first=json.Deserialize<Dictionary<string,object>>(lines[0]);
  var ready=json.Deserialize<Dictionary<string,object>>(lines[1]);
  var last=json.Deserialize<Dictionary<string,object>>(lines[lines.Length-1]);
  if(first["controlEpoch"]!=null||ready["controlEpoch"]==null||last["controlEpoch"]!=null)throw new Exception("readiness/drain state wrong");
  bool cleanup=false;var failed=new BackgroundProtocol(new Fake(),new StringWriter());
  if(failed.RunSession(new StringReader(""),()=>{throw new IOException("fixture");},()=>{cleanup=true;})==0||!cleanup)throw new Exception("failure cleanup missing");
  Console.WriteLine("PASS background unavailable-ready-EOF-drained and startup failure lifecycle");
  return 0;
 }catch(Exception e){Console.Error.WriteLine(e);return 1;}}
}
