// Bounded JPEG framing and SOF dimensions, not a decoder or a freshness claim.
export function readVmJpegDimensions(bytes){
  const invalid=()=>{throw new Error('Invalid VM JPEG frame');};
  if(!Buffer.isBuffer(bytes)||bytes.length<16||bytes.length>3*1024*1024||bytes[0]!==0xff||bytes[1]!==0xd8)invalid();
  let offset=2,width,height,sawScan=false,sawPixels=false;
  while(offset<bytes.length){
    if(bytes[offset++]!==0xff)invalid();
    while(bytes[offset]===0xff)offset++;
    if(offset>=bytes.length)invalid();
    const marker=bytes[offset++];
    if(marker===0xd9){
      if(offset!==bytes.length||!width||!height||!sawScan||!sawPixels)invalid();
      return {width,height};
    }
    if(marker===0x00||marker===0xd8||marker===0x01||marker>=0xd0&&marker<=0xd7||offset+2>bytes.length)invalid();
    const length=bytes.readUInt16BE(offset),end=offset+length;
    if(length<2||end>bytes.length)invalid();
    const sof=marker>=0xc0&&marker<=0xcf&&![0xc4,0xc8,0xcc].includes(marker);
    if(sof){
      if(width!==undefined||![0xc0,0xc1,0xc2].includes(marker)||length<8||bytes[offset+2]!==8)invalid();
      height=bytes.readUInt16BE(offset+3);width=bytes.readUInt16BE(offset+5);
      const components=bytes[offset+7];
      if(![1,3].includes(components)||length!==8+3*components||width<1||height<1||width>8192||height>8192||width*height>25_000_000)invalid();
    }
    offset=end;
    if(marker===0xda){
      if(!width||length<6)invalid();
      sawScan=true;
      // Scan entropy bytes: FF00 is data; restart markers do not end a scan.
      while(offset<bytes.length){
        if(bytes[offset]!==0xff){sawPixels=true;offset++;continue;}
        const start=offset;while(bytes[offset]===0xff)offset++;
        if(offset>=bytes.length)invalid();
        const next=bytes[offset];
        if(next===0x00||next>=0xd0&&next<=0xd7){offset++;sawPixels=true;continue;}
        offset=start;break;
      }
    }
  }
  invalid();
}
