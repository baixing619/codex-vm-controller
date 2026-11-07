using System;
using System.IO;
using System.Collections.Generic;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Web.Script.Serialization;

public sealed class InstallationPolicy {
    static readonly object Sync=new object();
    static InstallationPolicy current;
    public readonly string VmId,OwnerSid,HostMachine,Path,Sha256;
    InstallationPolicy(string path,string hash,string vm,string sid,string host){Path=path;Sha256=hash;VmId=vm;OwnerSid=sid;HostMachine=host;}
    public static InstallationPolicy Current {get{lock(Sync){if(current==null)current=Load(Environment.GetEnvironmentVariable("VM_CONTROLLER_POLICY"));return current;}}}
    public static InstallationPolicy Load(string path){
        if(string.IsNullOrWhiteSpace(path)||!System.IO.Path.IsPathRooted(path)||path.StartsWith(@"\\")||path.IndexOf('"')>=0)throw new InvalidOperationException("policy-path-invalid");
        path=System.IO.Path.GetFullPath(path);
        var file=new FileInfo(path);
        if(!file.Exists||file.Length<2||file.Length>8192||(file.Attributes&FileAttributes.ReparsePoint)!=0)throw new InvalidOperationException("policy-file-invalid");
        var directory=file.Directory;
        if(directory==null||(directory.Attributes&FileAttributes.ReparsePoint)!=0)throw new InvalidOperationException("policy-directory-invalid");
        byte[] bytes=File.ReadAllBytes(path);string hash;
        using(var sha=SHA256.Create())hash=BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-","").ToLowerInvariant();
        var data=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(System.Text.Encoding.UTF8.GetString(bytes).TrimStart('\uFEFF'));
        if(data==null||data.Count!=4||!data.ContainsKey("schemaVersion")||!object.Equals(data["schemaVersion"],1)||!data.ContainsKey("vmId")||!data.ContainsKey("ownerSid")||!data.ContainsKey("hostMachine"))throw new InvalidOperationException("policy-schema-invalid");
        string vm=data["vmId"] as string,sid=data["ownerSid"] as string,host=data["hostMachine"] as string;Guid guid;
        if(vm==null||!Guid.TryParseExact(vm,"D",out guid)||vm!=guid.ToString("D")||guid==Guid.Empty)throw new InvalidOperationException("policy-vm-invalid");
        if(string.IsNullOrWhiteSpace(sid)||string.IsNullOrWhiteSpace(host)||host.Length>64)throw new InvalidOperationException("policy-identity-invalid");
        new SecurityIdentifier(sid);
        AssertAcl(File.GetAccessControl(path),sid);
        AssertAcl(Directory.GetAccessControl(directory.FullName),sid);
        return new InstallationPolicy(path,hash,vm,sid,host);
    }
    static void AssertAcl(FileSystemSecurity acl,string sid){
        if(acl.GetOwner(typeof(SecurityIdentifier)).Value!=sid&&acl.GetOwner(typeof(SecurityIdentifier)).Value!="S-1-5-32-544")throw new InvalidOperationException("policy-owner-invalid");
        foreach(FileSystemAccessRule rule in acl.GetAccessRules(true,true,typeof(SecurityIdentifier))){
            string identity=rule.IdentityReference.Value;
            if(rule.AccessControlType==AccessControlType.Allow&&identity!=sid&&identity!="S-1-5-18"&&identity!="S-1-5-32-544")throw new InvalidOperationException("policy-acl-too-broad");
        }
    }
    public static void AssertOwner(){
        var policy=Current;
        using(var id=WindowsIdentity.GetCurrent()){
            if(id.User.Value!=policy.OwnerSid)throw new InvalidOperationException("identity-mismatch");
            if(new WindowsPrincipal(id).IsInRole(WindowsBuiltInRole.Administrator))throw new InvalidOperationException("elevated-owner-refused");
        }
        if(!string.Equals(Environment.MachineName,policy.HostMachine,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("host-mismatch");
    }
    public static void AssertWorkerIdentity(){
        var policy=Current;
        using(var id=WindowsIdentity.GetCurrent())if(id.User.Value!=policy.OwnerSid)throw new InvalidOperationException("worker-identity-mismatch");
        if(!string.Equals(Environment.MachineName,policy.HostMachine,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("worker-host-mismatch");
    }
    public static void InitializeVerified(string path,string expectedHash){
        if(expectedHash==null||!System.Text.RegularExpressions.Regex.IsMatch(expectedHash,"^[0-9a-f]{64}$"))throw new InvalidOperationException("policy-digest-invalid");
        var policy=Load(path);if(policy.Sha256!=expectedHash)throw new InvalidOperationException("policy-digest-changed");
        lock(Sync){if(current!=null&&(current.Path!=policy.Path||current.Sha256!=policy.Sha256))throw new InvalidOperationException("policy-already-bound");current=policy;}
    }
}
