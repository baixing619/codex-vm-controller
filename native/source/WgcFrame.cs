using System;
public static class WgcFrame {
    public static string ImageMime(byte[] bytes){
        if(bytes!=null&&bytes.Length>=8&&bytes[0]==137&&bytes[1]==80&&bytes[2]==78&&bytes[3]==71&&bytes[4]==13&&bytes[5]==10&&bytes[6]==26&&bytes[7]==10)return "image/png";
        if(bytes!=null&&bytes.Length>=4&&bytes[0]==255&&bytes[1]==216&&bytes[2]==255&&bytes[bytes.Length-2]==255&&bytes[bytes.Length-1]==217)return "image/jpeg";
        throw new InvalidOperationException("wgc-invalid-image-encoding");
    }
}
