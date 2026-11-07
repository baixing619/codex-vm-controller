using System;
using System.IO;
using System.Web.Script.Serialization;
using System.Collections.Generic;
static class PolicyTests {
 static int Main(){try{
  var policy=InstallationPolicy.Current;
  if(policy.VmId!="11111111-1111-4111-8111-111111111111")throw new Exception("fixture target not bound");
  bool rejected=false;try{InstallationPolicy.InitializeVerified(policy.Path,new string('0',64));}catch(InvalidOperationException){rejected=true;}
  if(!rejected)throw new Exception("changed snapshot accepted");
  InstallationPolicy.InitializeVerified(policy.Path,policy.Sha256);
  Console.WriteLine("PASS fixed policy binding and digest verification");
  return 0;
 }catch(Exception e){Console.Error.WriteLine(e);return 1;}}
}
