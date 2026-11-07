using System;
using System.IO;
using System.Threading;
using System.Text;

public static class Program {
    public static int Main(string[] args){
        if(args==null||args.Length!=1||args[0]!="--background-protocol")return 20;
        try{
            InstallationPolicy.AssertOwner();
            bool created;
            using(var mutex=new Mutex(true,"Local\\VmSingleConsole-"+InstallationPolicy.Current.VmId,out created)){
                if(!created)return 21;
                using(var input=new StreamReader(Console.OpenStandardInput(),new UTF8Encoding(false)))
                using(var output=new StreamWriter(Console.OpenStandardOutput(),new UTF8Encoding(false))){
                    output.AutoFlush=true;
                    return BackgroundProtocol.Run(input,output);
                }
            }
        }catch{return 22;}
    }
}
